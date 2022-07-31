
const tjs = require('teslajs');
const amqp = require('amqplib');
const path = require('path');
const dotenv = require('dotenv');
const https = require('https');

const timeout = ms => new Promise(res => setTimeout(res, ms))

//Load environment variables from .env file
dotenv.config({ path: path.join(process.env.ENV_FILES_DIR ? process.env.ENV_FILES_DIR : __dirname, '.env') });

const verboseMode = process.env.VERBOSE_MODE;
const refreshIntervalMs = 30000;
const fullRefreshIterations = 4;

let running = true;
let isDriving = false;
let currentIterationIndex = 0;

async function getSettings() {

    let response = {
        username: process.env.TESLA_USERNAME,
        password: process.env.TESLA_PASSWORD,
        token: process.env.TESLA_TOKEN,
        refreshToken: process.env.TESLA_REFRESH_TOKEN
    };
    if((!response.username || !response.password) && !response.token && !response.refreshToken) {
        return Promise.reject(new Error("Need to provide envoronment variables.  Either TESLA_TOKEN OR TESLA_REFRESH_TOKEN OR TESLA_USERNAME and TESLA_PASSWORD"));
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
            return Promise.reject(new Error(`Need to provide ${envName} environment variable`));
        }
        response[propertyName] = val;
    }
    
    return response;
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
            return callback(err);
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
        if (err) { 
            console.error(`Error getting data for ${sensorCategory}: ${err}`);
            console.error(JSON.stringify({
                getSensorDataFuncName,
                tjs,
                sensorCategory,
                options,
                results
            }));
            return callback(err);
        }
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

async function loginToTesla(config) {

    return await new Promise((resolve, reject) => {

        //If a refresh token is supplied in our config, get an access token from it
        if(config.refreshToken) {
            return getAccessTokenFromRefreshToken(config.refreshToken, (err, token) => {
                config.token = token;
                return resolve(token);
            });
        }

        //If token is supplied in our config, return it directly
        else if(config.token) {
            return resolve(config.token);
        }

        else {
            tjs.login({
                username: config.username,
                password: config.password,
                //mfaPassCode: mfaPassCode
            }, function(err, result) {
                if (result.error) {
                    return reject("Login Error: " + JSON.stringify(result.error))
                }

                var token = result.authToken;

                if (token) {
                    console.log("Login Succesful!");
                    console.log("Token:  " + token);
                }

                //Save for future calls into this method during the current session
                config.token = token;
                return resolve(token);
            });
        }
    });
}

function getAccessTokenFromRefreshToken(refreshToken, callback) {

    const xFormBody = `${encodeURI('grant_type')}=${encodeURI('refresh_token')}&${encodeURI('client_id')}=${encodeURI("ownerapi")}&${encodeURI('refresh_token')}=${encodeURI(refreshToken)}`;
    
    var urlParams = {
        host: 'auth.tesla.com', //No need to include 'http://' or 'www.'
        port: 443,
        path: '/oauth2/v3/token/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(xFormBody)
        }
    };

    performHttpPostAndGetResponse(urlParams, xFormBody, (err, response) => {
        if(err) {
            return callback(err);
        }

        let msg = JSON.parse(response);
        console.log(`Received access token which will expire in ${msg.expires_in} seconds`);
        return callback(null, msg.access_token);
    });
}

function performHttpPostAndGetResponse(urlParams, body, callback) {
    var str = '';
    var cb = function(response) {
        response.on('data', function (chunk) {
            str += chunk;
        });
        response.on('end', function() {
            callback(null, str);
        });
        response.on('error', function(err) {
            console.warn("Error getting HTTP response on auth");
            callback(err);
        });
    };

    var req = https.request(urlParams, cb);
    req.write(body);
    req.end();    
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
    let settings = null;
    try {
        console.log("Getting settings");
        settings = await getSettings();   
    } catch (error) {
        console.error("Failed to get settings: " + error);
        return;
    }

    //Login to Tesla
    let authToken = null;
    try {
        console.log("Getting Tesla auth token");
        authToken = await loginToTesla(settings);
        console.log("Logged in successfully");
    } catch (error) {
        console.error("Failed to log in: " + error);
    }
    
    //Connect to Service Bus
    let channel = null;
    try {
        console.log("Connecting to service bus");
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
        try {
            await new Promise((resolve, reject) => {
                updateTeslaSensorData(settings, channel, async (err) => {
                    if(err) {
                        return reject(err);
                    }
                    resolve();                            
                });
            });
        } catch (err) {
            if(err === "Unauthorized") {
                //HACK:  Exit application, allowing it to be restarted (and reauthenticated)
                console.warn("Last error indicated that we're no longer authenticated, so we'll retry auth");
                try {
                authToken = await loginToTesla(settings);
                }
                catch(authError) {
                    console.error("Failed to reauthenticate: " + authError);
                    process.exit(-2);
                }
            }
            else {
                console.warn("Error running iteration (will wait and try again): " + err);
            }
        }
        await timeout(60000);
    }
}

run();

console.log("Run loop exited");