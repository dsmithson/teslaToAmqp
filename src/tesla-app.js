const { delay } = require('bluebird');
var tjs = require('teslajs');
var path = require('path');
var amqp = require('amqplib');
var dotenv = require('dotenv');
var process = require('process');

//Load environment variables from .env file
dotenv.config({ path: path.join(process.env.ENV_FILES_DIR ? process.env.ENV_FILES_DIR : __dirname, '.env') });


const verboseMode = process.env.VERBOSE_MODE;
const refreshIntervalMs = 30000; 
const fullRefreshIterations = 4;

let running = true;
let isDriving = false;
let currentIterationIndex = 0;

function getSettings(callback) {

    let response = {
        username: process.env.TESLA_USERNAME,
        password: process.env.TESLA_PASSWORD,
        token: process.env.TESLA_TOKEN
    };
    if((!response.username && !response.password) || !response.token) {
        return callback(new Error("Need to provide envoronment variables.  Either TESLA_TOKEN OR TESLA_USERNAME and TESLA_PASSWORD"));
    }

    let otherRequiredFields = 
    [ 
        [ 'AMQP_CONN', 'amqpConnectionString' ], 
        [ 'AMQP_EXCHANGE', 'exchangeName'],
        [ 'AMQP_EXCHANGE_TYPE', 'exchangeType' ],
        [ 'AMQP_ROUTING_KEY', 'routingKey' ]
    ];
    for(let i=0; i<otherRequiredFields.length; i++) {
        
        let field = otherRequiredFields[i];
        let envName = field[0];
        let propertyName = field[1];
        let val = process.env[envName];

        if(!val) {
            return callback(new Error(`Need to provide ${envName} environment variable`));
        }
        response[propertyName] = val;
    }
    
    return callback(null, response);
}

function updateTeslaSensorData(settings, servicebus, callback) {

    console.log(`[${new Date().toISOString()}] Starting to get tesla sensors`);

    //Get Vehicle data (needed to get started)
    //console.error("logging in with token:" + settings.token);
    var options = { authToken: settings.token };

    let fullObject = {};
    processSensors('vehicle_info', 'vehicle', options, fullObject, (err, vehicle) => {
        if (err || !vehicle) {
            console.error("Failed to get vehicle: " + err);
            return callback(null);
        }

        if(verboseMode) console.log(`Processed sensors: ${JSON.stringify(vehicle)}`);

        //Debug
        //console.log(`pulled vehicle status: ${JSON.stringify(vehicle)}`);

        //If the car is asleep or in service, we won't be able to get other state info, so we can stop now
        if (vehicle.status == "asleep" || vehicle.in_service) {

            if(verboseMode) console.log("Vehicle is asleep");

            //Write partial object to service bus
            writeVehicleInfoToServiceBus(servicebus, fullObject, (err) => {
                return callback();
            });
        }
        else {
            //Process vehicle sensors
            let methodsByCategory = [];
            if(isDriving || currentIterationIndex == 0) {
                //Update drive state as often as allowed while driving
                methodsByCategory.push({ category: 'drive_state', method: 'driveState' });
            }

            //Update all other readings on a more relaxed interval
            if(currentIterationIndex == 0) {
                methodsByCategory.push({ category: 'vehicle_state', method: 'vehicleState' });
                methodsByCategory.push({ category: 'charge_state', method: 'chargeState' });
                methodsByCategory.push({ category: 'climate_state', method: 'climateState' });
            }

            //Update our iterations
            currentIterationIndex++;
            if(currentIterationIndex > fullRefreshIterations) {
                currentIterationIndex = 0;
            }

            //Do we have anything to update?
            if(methodsByCategory.length === 0) {
                return callback(null);
            }

            processList(methodsByCategory, (item, cb) => processSensors(item.category, item.method, options, fullObject, cb), 1, (err) => {

                //Update our driving state (if available)
                let driveState = fullObject["drive_state"];
                if(driveState && driveState.shift_state) {
                    //We're driving if we're in any gear other than Park
                    isDriving = driveState.shift_state != "P";
                }

                //Write full object to the service bus
                writeVehicleInfoToServiceBus(settings, servicebus, fullObject, (err) => {
                    return callback(null);
                });
            });
        }
    });
}

function writeVehicleInfoToServiceBus(settings, servicebus, fullObject, callback) {

    let fullObjectString = JSON.stringify(fullObject);
    if(verboseMode) console.log(`Writing tesla sensors to service bus ${settings.exchangeType} '${settings.exchangeName}/${settings.routingKey}': ${fullObjectString}`);

    let success = servicebus.publish(settings.exchangeName, settings.routingKey, Buffer.from(fullObjectString), { contentType: 'application/json' });
    if(!success) {
        return callback(new Error("Failed to write vehicle info to service bus"));
    }
    return callback(null);
}

function processSensors(sensorCategory, getSensorDataFuncName, options, fullObject, callback) {

    //Get data from Tesla API
    tjs[getSensorDataFuncName](options, (err, results) => {
        if (err) console.error(`Error getting data for ${sensorCategory}: ${err}`);
        if (results == null) return callback(null);

        if (verboseMode) console.log(`Received ${sensorCategory} state: ${JSON.stringify(results)}`);

        //Add to full object
        fullObject[sensorCategory] = results;
        return callback(null, results);
    });
}


function processList(items, doFunc, maxConcurrency, callback) {
    let nextItem = 0;
    let results = new Array(items.length);
    let failed = false;

    if (items.length === 0) {
        setImmediate(() => callback());
        return;
    }

    function handleResult(index, err, result) {
        if (failed) return;
        if (err) {
            failed = true;
            callback(err);
            return;
        }
        results[index] = result;
        processNext();
    }

    function processNext() {
        if (failed) return;
        if (nextItem >= items.length) {
            return callback(null, results);
        } 
        const index = nextItem++;
        try {
            doFunc(items[index], (e, r) => handleResult(index, e, r));
        }
        catch(e) {
            handleResult(index, e, undefined);
        }
    }

    for(let i = 0; i < Math.min(maxConcurrency, items.length); i++) {
        processNext();
    }
}

function loginToTesla(config, callback) {

    //If token is supplied in our config, return it directly
    if(config.token) {
        return callback(null, config.token);
    }

    tjs.login({
        username: config.username,
        password: config.password,
        //mfaPassCode: mfaPassCode
    }, function(err, result) {
        if (result.error) {
            console.log(JSON.stringify(result.error));
            process.exit(1);
        }

        var token = JSON.stringify(result.authToken);

        if (token) {
            console.log("Login Succesful!");
            console.log("Token:  " + token);
        }

        //Save for future calls into this method during the current session
        config.token = token;
        return callback(null, token);
    });
}

function killProcess() {
    running = false;
}

process.on('SIGTERM', killProcess);
process.on('SIGINT', killProcess);
process.on('uncaughtException', function(e) {
    console.log('[uncaughtException] app will be terminated: ', e.stack);
    killProcess();
});

async function run() {

    //Get settings
    getSettings((err, settings) => {
        if(err) {
            console.log(err);
            return;
        }
        loginToTesla(settings, async (err) => {
            if(err) {
                console.log("Failed to log in: " + err);
                return;
            }
            
            //Connect to service bus
            let channel = null;
            try {
                //Connect to service bus
                var conn = await amqp.connect(settings.amqpConnectionString);
                channel = await conn.createChannel();
                await channel.assertExchange(settings.exchangeName, settings.exchangeType, { durable: true });
            }
            catch(error) {
                console.error("Failed to connect to AMQP:  " + error);
                return;
            }

            //Register to run our update interval
            while(running) {
                //let pollingInterval = setInterval(updateTeslaSensorData, refreshIntervalMs, settings, channel, callback);
                updateTeslaSensorData(settings, channel, async (err) => {
                    if(err) {
                        console.warn("Error running iteration: " + err);
                        await delay(60000);
                    }
                });
                await delay(refreshIntervalMs);
            }

            // setTimeout(function() {
            //     if (running) run();
            // }, 10); 
        });
    });
}

run();