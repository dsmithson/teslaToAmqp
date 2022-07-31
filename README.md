# TeslaToAmqp
Connects to Tesla API and sends vehicle data, including realTime positional info, to an AMQP 0.9.1 Exchange

## Configuring with Environment Variables

This program uses a number of environment variables for configuration.  These are listed below.  The app will load these values from a .env file if present.

Note on the auth options.  You can provide either a Tesla username/password, or if you have a pre-negotiated token you can supply it directly.  

### Values

- TESLA_USERNAME=(Tesla accountemail)
- TESLA_PASSWORD=(Tesla account password)
- TESLA_TOKEN=(Token from Tesla auth) - this can be provided in lieu of an actual username/password.  This will timeout and can't be refreshed, so not a great option
- TESLA_REFRESH_TOKEN=If provided, the app will attempt to obtain an access token using this refresh token
- AMQP_CONN=amqp://(user):(pass)@(amqp server)
- AMQP_EXCHANGE=(amqp exchange name)
- AMQP_EXCHANGE_TYPE=(amqp exchange type)
- AMQP_ROUTINGKEY=(amqp routing key)

### Example (Refresh Token Auth)
This is the recommended way to run the app, as the app can get a new refresh token as needed.  

Use this page to obtain a refresh token:  [https://tesla-info.com/tesla-token.php](https://tesla-info.com/tesla-token.php)

- TESLA_REFRESH_TOKEN=ezkadkjlakjlfkjlfkljfkljfjkfekjlfkljkfljkfjlkj....
- AMQP_CONN=amqp://user:pass@192.168.20.23
- AMQP_EXCHANGE=knightware.tesla
- AMQP_EXCHANGE_TYPE=topic
- AMQP_ROUTINGKEY=actions.write

### Example (Username/Password auth)

- TESLA_USERNAME=myemail@domain.com
- TESLA_PASSWORD=MySecretPassword
- AMQP_CONN=amqp://user:pass@192.168.20.23
- AMQP_EXCHANGE=knightware.tesla
- AMQP_EXCHANGE_TYPE=topic
- AMQP_ROUTINGKEY=actions.write

### Example (Token auth)

- TESLA_TOKEN=SomeTokenFromTeslaOAuthEndpoint
- AMQP_CONN=amqp://user:pass@192.168.20.23
- AMQP_EXCHANGE=knightware.tesla
- AMQP_EXCHANGE_TYPE=topic
- AMQP_ROUTINGKEY=actions.write