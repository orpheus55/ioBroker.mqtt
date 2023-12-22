'use strict';

const mqtt            = require('mqtt-connection');
const state2string    = require('./common').state2string;
const convertTopic2id = require('./common').convertTopic2id;
const convertID2topic = require('./common').convertID2topic;
const ensureObjectStructure = require('./common').ensureObjectStructure;
const convertMessage  = require('./common').convertMessage;
const messageboxRegex = new RegExp('\\.messagebox$');

// todo delete from persistentSessions the sessions and messages after some time

function MQTTServer(adapter, states) {
    if (!(this instanceof MQTTServer)) {
        return new MQTTServer(adapter, states);
    }

    const namespaceRegEx = new RegExp(`^${adapter.namespace.replace('.', '\\.')}\\.`);

    let net;
    let http;
    let ws;
    let wsStream;
    let server      = null;
    let serverWs    = null;
    let serverForWs = null;
    const clients   = {};
    const topic2id  = {};
    const id2topic  = {};
    let messageId   = 1;
    let persistentSessions = {};
    let resending   = false;
    let resendTimer = null;
    const verifiedObjects = {};

    adapter.config.sendOnStartInterval = parseInt(adapter.config.sendOnStartInterval, 10) || 2000;
    adapter.config.sendInterval        = parseInt(adapter.config.sendInterval,        10) || 0;

    this.destroy = (cb) => {
        if (resendTimer) {
            clearInterval(resendTimer);
            resendTimer = null;
        }
        persistentSessions = {};
        let tasks = 0;
        let timeout;
        if (cb) {
            timeout = setTimeout(() => {
                timeout = null;
                if (cb) {
                    cb();
                    cb = null;
                }
            }, 2000);
        }
        if (server) {
            tasks++;
            // to release all resources
            server.close(() => {
                console.log('all gone!');
                if (!--tasks && cb) {
                    clearTimeout(timeout);
                    cb();
                    cb = null;
                }
            });
            server = null;
        }

        if (serverForWs) {
            tasks++;
            // to release all resources
            serverForWs.close(() => {
                console.log('all ws gone!');
                if (!--tasks && cb) {
                    clearTimeout(timeout);
                    cb();
                    cb = null;
                }
            });
            serverForWs = null;
        }
        if (!tasks && cb) {
            clearTimeout(timeout);
            cb();
            cb = null;
        }
    };

    this.onMessage = (topic, message, retain, binary) => {
        if (server) {
            setImmediate(() => {
                for (const k in clients) {
                    if (Object.prototype.hasOwnProperty.call(clients, k)) {
                        sendMessage2Client(clients[k], topic, message, adapter.config.defaultQoS, retain ?? adapter.config.retain, binary);
                    }
                }

                /*
                for (let clientId in persistentSessions) {
                    if (persistentSessions.hasOwnProperty(clientId) && !clients[clientId]) {
                        (function (_clientId) {
                            getMqttMessage(persistentSessions[_clientId], id, state, adapter.config.defaultQoS, true, (err, message) => {
                                message && persistentSessions[_clientId].messages.push(message);
                            });
                        })(clientId);
                    }
                }
				*/
            });
        }
    };

    this.onStateChange = (id, state) => {
        adapter.log.debug(`onStateChange ${id}: ${JSON.stringify(state)}`);

        if (server) {
            setImmediate(() => {
                if (state && state.binary) {
                    let promise;
                    if (adapter.getForeignBinaryStateAsync) {
                        promise = adapter.getForeignBinaryStateAsync(id);
                    } else {
                        promise = adapter.getBinaryStateAsync(id);
                    }

                    // read first the state
                    promise
                        .then(buffer => {
                            Object.keys(clients).forEach(k =>
                                sendState2Client(clients[k], id, buffer, adapter.config.defaultQoS, !adapter.config.noRetain));

                            Object.keys(persistentSessions).forEach(clientId => {
                                if (!clients[clientId]) {
                                    getMqttMessage(persistentSessions[clientId], id, buffer, adapter.config.defaultQoS, !adapter.config.noRetain, (err, message, persistentClient) =>
                                        message && persistentClient && addMessageWithTopicCheck(persistentClient.messages, message));
                                }
                            });
                        })
                        .catch(error => adapter.log.warn(`Cannot read binary state: ${error}`));
                } else {
                    Object.keys(clients).forEach(k =>
                        sendState2Client(clients[k], id, state, adapter.config.defaultQoS, !adapter.config.noRetain));

                    Object.keys(persistentSessions).forEach(clientId => {
                        if (!clients[clientId]) {
                            getMqttMessage(persistentSessions[clientId], id, state, adapter.config.defaultQoS, !adapter.config.noRetain, (err, message, persistentClient) =>
                                message && persistentClient && addMessageWithTopicCheck(persistentClient.messages, message));
                        }
                    });
                }
            });
        }
    };

    function updateClients() {
        adapter.setState('info.connection', {val: clients ? Object.keys(clients).join(',') : '', ack: true});
    }

    function getMqttMessage(client, id, state, qos, retain, cb) {
        if (typeof qos === 'function') {
            cb  = qos;
            qos = undefined;
        }
        if (typeof retain === 'function') {
            cb  = retain;
            retain = undefined;
        }

        if (!id2topic[id]) {
            return adapter.getForeignObject(id, (err, obj) => {
                if (err) {
                    return cb(`Client [${client.id}] Cannot resolve topic name for ID: ${id} (err: ${err})`);
                }
                if (!obj) {
                    return cb(`Client [${client.id}] Cannot resolve topic name for ID: ${id} (object not found)`);
                } else if (!obj._id) {
                    return cb(`Client [${client.id}] Cannot resolve topic name for ID: ${id} (object has no id): ${JSON.stringify(obj)}`);
                } else if (!obj.native || !obj.native.topic) {
                    id2topic[obj._id] = convertID2topic(obj._id, null, adapter.config.prefix, adapter.namespace, adapter.config.removePrefix);
                } else {
                    id2topic[obj._id] = obj.native.topic;
                }

                const topic = id2topic[obj._id];
                obj.common = obj.common || {};

                topic2id[topic] = topic2id[topic] || {obj, id: obj._id};

                getMqttMessage(client, obj._id, state, qos, retain, cb);
            });
        }

        // client has subscription for this ID
        let message;
        let topic;
        let pattern;

        if (client._subsID && client._subsID[id]) {
            topic = id2topic[id];

            let payload;
            if (!state) {
                payload = null;
            } else {
                if (topic2id[topic].obj && topic2id[topic].obj.common.type === 'file') {
                    payload = state;
                    if (!Buffer.isBuffer(payload)) {
                        payload = null;
                    }
                } else {
                    payload = state2string(state.val);
                }
            }

            message = {
                topic: adapter.config.extraSet && state && !state.ack ? `${topic}/set` : topic,
                payload,
                qos: client._subsID[id].qos
            };
        } else {
            //  Check patterns
            if (client._subs && (pattern = checkPattern(client._subs, id)) !== null) {
                topic = id2topic[id];
                // Cache the value
                client._subsID = client._subsID || {};
                client._subsID[id] = pattern;

                let payload;
                if (!state) {
                    payload = null;
                } else {
                    if (topic2id[topic].obj && topic2id[topic].obj.common.type === 'file') {
                        payload = state;
                        if (!Buffer.isBuffer(payload)) {
                            payload = null;
                        }
                    } else {
                        payload = state2string(state.val);
                    }
                }

                message = {
                    topic: adapter.config.extraSet && state && !state.ack ? `${topic}/set` : topic,
                    payload,
                    qos: pattern.qos
                };
            }
        }

        if (message) {
            message = addMessageAttributes(message, {qos, retain});
        }

        cb(null, message, client);
    }

    function getNextMessageId() {
        const id = messageId;

        messageId++;
        if (messageId > 65535) {
            messageId = 1;
        }

        return id;
    }

    function addMessageAttributes(message, attributes) {
        message = Object.assign(message, {
            qos: message.qos === undefined ? attributes.qos : message.qos,
            retain: attributes.retain,
            messageId: messageId,
            ts: Date.now(),
            count: 0,
            cmd: 'publish',
        });

        return message;
    }

    function sendMessage2Client(client, topic, payload, qos, retain, binary) {
        const message = addMessageAttributes({topic, payload, binary}, {qos: client._subsID && client._subsID[topic] ? client._subsID[topic].qos : undefined, retain});
        if (message) {
            message.payload = state2string(payload);
            if (adapter.config.debug) {
                adapter.log.debug(`Client [${client.id}] send to this client "${message.topic}" (retain: ${message.retain}): ${(message.payload !== null ? message.payload : 'deleted')}`);
            }

            client.publish(message);

            if (message.qos > 0) {
                client._messages = client._messages || [];
                client._messages.push(message);
            }
        }
    }

    function sendState2Client(client, id, state, qos, retain, cb) {
        if (messageboxRegex.test(id)) {
            return;
        }

        getMqttMessage(client, id, state, qos, retain, (err, message, client) => {
            if (message) {
                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] send to this client "${message.topic}": ${message.payload !== null ? message.payload : 'deleted'}`);
                }

                client.publish(message);

                if (message.qos > 0) {
                    client._messages = client._messages || [];
                    client._messages.push(message);
                }
            }
            cb && cb(id);
        });
    }

    function sendStates2Client(client, list) {
        if (list && list.length) {
            const id = list.shift();
            sendState2Client(client, id, states[id], 0, !adapter.config.noRetain, () =>
                setTimeout(() => sendStates2Client(client, list), adapter.config.sendInterval));
        } else {
            //return;
        }
    }

    function resendMessages2Client(client, messages, i) {
        i = i || 0;
        if (messages && i < messages.length) {
            try {
                messages[i].ts = Date.now();
                messages[i].count++;
                adapter.log.debug(`Client [${client.id}] Resend messages on connect: ${messages[i].topic} and id ${messages[i].messageId} (${messages[i].cmd}) = ${messages[i].payload}`);
                if (messages[i].cmd === 'publish') {
                    messages[i].messageId = getNextMessageId();
                    client.publish(messages[i]);
                }
            } catch (e) {
                adapter.log.warn(`Client [${client.id}] Cannot resend message: ${e}`);
            }

            if (adapter.config.sendInterval) {
                setTimeout(() => resendMessages2Client(client, messages, i + 1), adapter.config.sendInterval);
            } else {
                setImmediate(() => resendMessages2Client(client, messages, i + 1));
            }
        } else {
            // return;
        }
    }

    /*
     4.7.1.2 Multi-level wildcard

     The number sign (‘#’ U+0023) is a wildcard character that matches any number of levels within a topic. The multi-level wildcard represents the parent and any number of child levels. The multi-level wildcard character MUST be specified either on its own or following a topic level separator. In either case it MUST be the last character specified in the Topic Filter [MQTT-4.7.1-2].

     Non-normative comment,
     For example, if a Client subscribes to “sport/tennis/player1/#”, it would receive messages published using these topic names:
     ·         “sport/tennis/player1”
     ·         “sport/tennis/player1/ranking”
     ·         “sport/tennis/player1/score/wimbledon”

     Non-normative comment
     ·         “sport/#” also matches the singular “sport”, since # includes the parent level.
     ·         “#” is valid and will receive every Application Message
     ·         “sport/tennis/#” is valid
     ·         “sport/tennis#” is not valid
     ·         “sport/tennis/#/ranking” is not valid

     */
    function checkPattern(patterns, id) {
        const pattern = Object.keys(patterns).find(p => patterns[p].regex.test(id));

        return pattern ? patterns[pattern] : null;
    }

    async function processTopic(id, topic, message, qos, retain, isAck, ignoreClient) {
        if (id === `${adapter.namespace}.info.connection`) {
            adapter.log.debug(`Ignore State update for ${id} because adapter internal state.`);
            return;
        }

        // expand an old version of objects
        const messageType = typeof message;
        const obj = topic2id[topic].obj;
        if (namespaceRegEx.test(id) &&
            ((!obj.native || !obj.native.topic) ||
                (obj.common && obj.common.type !== 'file' && obj.common.type !== 'mixed' && obj.common.type !== messageType))) {
            if (obj.common && obj.common.type !== 'file' && obj.common.type !== 'mixed' && obj.common.type !== messageType) {
                // mqtt topics could change types, but log it to communicate to the user, if a type is frequently fluctuating
                adapter.log.info(`Server: Changed type of "${id}" from "${obj.common.type}" to "${messageType}"`);
                obj.common.type = messageType;
            }

            obj.native       = obj.native || {};
            obj.native.topic = topic;
            try {
                await adapter.setForeignObjectAsync(id, obj);
            } catch (e) {
                adapter.log.error(`Could not update object "${id}": ${e.message}`);
            }
        }

        adapter.config.debug && adapter.log.debug(`Server received "${topic}" (${typeof message}): ${JSON.stringify(message)}`);

        if (message !== undefined) {
            if (obj.common.type === 'file') {
                if (adapter.setForeignBinaryStateAsync) {
                    await adapter.setForeignBinaryStateAsync(id, message);
                } else {
                    await adapter.setBinaryStateAsync(id, message);
                }

                states[id] = { binary: true };
            } else {
                let value;
                if (typeof message === 'object') {
                    value = message;
                } else {
                    value = {val: message, ack: isAck};
                }
                if (value.val !== undefined &&
                    value.val !== null &&
                    namespaceRegEx.test(topic2id[topic].id) &&
                    topic2id[topic].obj &&
                    topic2id[topic].obj.common &&
                    topic2id[topic].obj.common.type !== 'mixed' &&
                    topic2id[topic].obj.common.type !== typeof value.val
                ) {
                    adapter.log.info(`Server: Changed type of "${topic2id[topic].id}" from "${topic2id[topic].obj.common.type}" to "mixed"`);
                    try {
                        await adapter.extendObjectAsync(topic2id[topic].id, {common: { type: 'mixed'}});
                    } catch (err) {
                        adapter.log.warn(`Error while updating object "${topic2id[topic].id}" for Server: ${err}`);
                    }
                    topic2id[topic].obj.common.type = 'mixed';
                }
                try {
                    await adapter.setForeignStateAsync(id, value);
                } catch (err) {
                    // ignore
                }

                states[id] = value;
            }
        } else {
            states[id] = {val: null, ack: isAck};
        }

        // send a message to all other clients
        if (adapter.config.onchange && server && message !== undefined) {
            setImmediate(() => {
                if (typeof message !== 'object') {
                    message = {val: message};
                }

                Object.keys(clients).forEach(k => {
                    // if 'get' and 'set' have different topic names, send state to issuing a client too.
                    if (clients[k] !== ignoreClient || adapter.config.extraSet) {
                        sendState2Client(clients[k], id, message, qos, retain);
                    }
                });
            });
        }
        // ELSE
        // this will be done indirect. The message will be sent to js-controller, and if adapter is subscribed, it gets this message over stateChange
    }

    async function checkObject(id, topic, message) {
        topic2id[topic] = topic2id[topic] || {id: null};

        adapter.config.debug && adapter.log.debug(`Check object for topic "${topic}"`);

        let obj;
        try {
            obj = await adapter.getObjectAsync(id);
        } catch (err) {
            // ignore
        }

        if (obj &&
            obj._id &&
            obj._id.startsWith(`${adapter.namespace}.`) &&
            obj.type === 'folder' &&
            obj.native &&
            obj.native.autocreated === 'by automatic ensure logic'
        ) {
            // ignore a default created object because we now have a more defined one
            obj = null;
        }

        if (!obj) {
            try {
                obj = await adapter.getForeignObjectAsync(id);
            } catch (err) {
                // ignore
            }
            if (obj &&
                obj._id &&
                obj._id.startsWith(`${adapter.namespace}.`) &&
                obj.type === 'folder' &&
                obj.native &&
                obj.native.autocreated === 'by automatic ensure logic'
            ) {
                // ignore a default created object because we now have a more defined one
                obj = null;
            }

            if (!obj) {
                id = `${adapter.namespace}.${id}`;

                if (adapter.config.ignoreNewObjects) {
                    adapter.log.warn(`Object ${id} ignored and not created`);
                    throw new Error(`Object ${id} not exists`);
                }

                // only for type detection
                message = convertMessage(topic, message, adapter);

                // create state
                obj = {
                    _id: id,
                    common: {
                        name:  topic,
                        write: true,
                        read:  true,
                        role:  'variable',
                        desc:  'mqtt server variable',
                        type:  adapter.config.allBinaries ? 'file' : (message !== undefined ? typeof message : 'string'),
                    },
                    native: {
                        topic
                    },
                    type: 'state'
                };
                if (!adapter.config.allBinaries && obj.common.type === 'object' && message !== undefined && message.val !== undefined) {
                    obj.common.type = typeof message.val;
                }

                adapter.log.debug(`Create object for topic: ${topic}[ID: ${id}]`);
                try {
                    await adapter.setForeignObjectAsync(id, obj);
                } catch (err) {
                    // ignore
                }
            } else {
                adapter.config.debug && adapter.log.debug(`    Found object for topic "${topic}" = ${obj._id}`);
            }
        } else {
            adapter.config.debug && adapter.log.debug(`    Found object for topic "${topic}" = ${obj._id}`);
        }
        if (obj && !obj._id) {
            obj._id = id;
        }
        topic2id[topic].id = obj._id;
        topic2id[topic].obj = obj;

        // do not wait the finish of the function
        ensureObjectStructure(adapter, obj._id, verifiedObjects)
            .then(() => {});
    }

    /*4.7.1.3 Single level wildcard

     The plus sign (‘+’ U+002B) is a wildcard character that matches only one topic level.

     The single-level wildcard can be used at any level in the Topic Filter, including first and last levels. Where it is used it MUST occupy an entire level of the filter [MQTT-4.7.1-3]. It can be used at more than one level in the Topic Filter and can be used in conjunction with the multilevel wildcard.

     Non-normative comment
     For example, “sport/tennis/+” matches “sport/tennis/player1” and “sport/tennis/player2”, but not “sport/tennis/player1/ranking”. Also, because the single-level wildcard matches only a single level, “sport/+” does not match “sport” but it does match “sport/”.

     Non-normative comment
     ·         “+” is valid
     ·         “+/tennis/#” is valid
     ·         “sport+” is not valid
     ·         “sport/+/player1” is valid
     ·         “/finance” matches “+/+” and “/+”, but not “+”
     */
    function pattern2RegEx(pattern) {
        pattern = convertTopic2id(pattern, true, adapter.config.prefix, adapter.namespace);
        pattern = pattern.replace(/#/g, '*');
        pattern = pattern.replace(/\$/g, '\\$');
        pattern = pattern.replace(/\^/g, '\\^');

        if (pattern !== '*') {
            if (pattern[0] === '*' && pattern[pattern.length - 1] !== '*') {
                pattern += '$';
            }
            if (pattern[0] !== '*' && pattern[pattern.length - 1] === '*') {
                pattern = `^${pattern}`;
            }
            if (pattern[0] === '+') {
                pattern = `^[^.]*${pattern.substring(1)}`;
            }
            if (pattern[pattern.length - 1] === '+') {
                pattern = `${pattern.substring(0, pattern.length - 1)}[^.]*$`;
            }
        } else {
            return '.*';
        }
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/\\\.\*/g, '\\..*');
        pattern = pattern.replace(/\+/g, '[^.]*');
        return pattern;
    }

    async function receivedTopic(packet, client) {
        let   isAck   = true;
        let   topic   = packet.topic;
        let   message = packet.payload;
        const qos     = packet.qos;
        const retain  = packet.retain;
        const now     = Date.now();
        let   id;

        if (adapter.config.extraSet && packet.topic.match(/\/set$/)) {
            isAck = false;
            packet.topic = packet.topic.substring(0, packet.topic.length - 4);
            topic = packet.topic;
        }

        if (topic2id[topic]) {
            id = topic2id[topic].id || convertTopic2id(topic, false, adapter.config.prefix, adapter.namespace);
        } else {
            id = convertTopic2id(topic, false, adapter.config.prefix, adapter.namespace);
        }

        if (!id) {
            adapter.log.error(`Client [${client.id}] Invalid topic name: ${JSON.stringify(topic)}`);
            return;
        }

        // If state is unknown => create mqtt.X.topic
        if ((`${adapter.namespace}.${id}`).length > adapter.config.maxTopicLength) {
            adapter.log.warn(`Client [${client.id}] Topic name is too long: ${id.substring(0, 100)}...`);
            return;
        }

        if (!topic2id[topic]) {
            try {
                await checkObject(id, topic, message);
            } catch (err) {
                return;
            }
        } else if (topic2id[topic].id === null) {
            // still looking for id
            topic2id[topic].message = message;
            adapter.config.debug && adapter.log.debug(`Client [${client.id}] Server received (but in process) "${topic}" (${typeof message}): ${message}`);
            return;
        }

        if (topic2id[topic].message) {
            // get last received message
            message = topic2id[topic].message;
            delete topic2id[topic].message;
        }

        if (topic2id[topic].obj && topic2id[topic].obj.common.type !== 'file') {
            message = convertMessage(topic, message, adapter, client.id);
        }

        if (qos) {
            Object.keys(persistentSessions).forEach(clientId => {
                if (clientId !== client.id && !persistentSessions[clientId].connected) {
                    // try to collect this message if a client subscribed
                    getMqttMessage(persistentSessions[clientId], id, message, adapter.config.defaultQoS, true, (err, sendMessage, persistentClient) =>
                        // if sendMessage is defined, then the message should be delivered because subscribed, but we deliver the original message
                        sendMessage && persistentClient && addMessageWithTopicCheck(persistentClient.messages, {topic, qos, retain, messageId: packet.messageId || sendMessage.messageId, ts: now, payload: message, count: 0, cmd: 'publish'}));
                }
            });
        }

        await processTopic(topic2id[topic].id, topic, message, qos, retain, isAck, client);
    }

    function addMessageWithTopicCheck(arr, message) {
        for (const i in arr) {
            if (arr[i].topic === message.topic) {
                // if same topic we do not add a new entry, but pot. update existing of newer
                if (message.ts > arr[i].ts) {
                    arr[i] = message;
                }
                return false;
            }
        }
        arr.push(message);
    }

    function clientClose(client, reason) {
        if (!client) {
            return;
        }

        if (persistentSessions[client.id]) {
            persistentSessions[client.id].connected = false;
        }

        if (client._sendOnStart) {
            clearTimeout(client._sendOnStart);
            client._sendOnStart = null;
        }
        if (client._resendonStart) {
            clearTimeout(client._resendonStart);
            client._resendonStart = null;
        }

        try {
            if (clients[client.id] && (client.__secret === clients[client.id].__secret)) {
                adapter.log.info(`Client [${client.id}] connection closed: ${reason}`);
                delete clients[client.id];
                updateClients();
                if (client._will && reason !== 'disconnected') {
                    receivedTopic(client._will, client)
                        .catch(() => null) // ignore
                        .then(() => client.destroy());
                } else {
                    client.destroy();
                }
            } else {
                client.destroy();
            }
        } catch (e) {
            adapter.log.warn(`Client [${client.id}] Cannot close client: ${e}`);
        }
    }

    function validateRequest(type, client, config) {
        if (config.user && !client.authenticated) {
            adapter.log.warn(`Client [${client.id}] sends ${type} after unsuccessful authentication. Ignore!`);
            return false;
        }
        
        if (clients[client.id] && client.__secret !== clients[client.id].__secret) {
            adapter.log.debug(`Old client ${client.id} with secret ${client.__secret} sends ${type}. Ignore! Actual secret is ${clients[client.id].__secret}`);
            return false;
        }

        return true;
    }
    
    function startServer(config, socket, server, port, bind, ssl, ws) {
        socket.on('connection', stream => {
            let client;
            if (ws) {
                client = mqtt(wsStream(stream));
            } else {
                client = mqtt(stream);
            }

            // Store unique connection identifier
            client.__secret = `${Date.now()}_${Math.round(Math.random() * 10000)}`;

            client.on('connect', options => {
                // set client id
                client.id = options.clientId;
                if (adapter.config.forceCleanSession === 'clean') {
                    client.cleanSession = true;
                } else if (adapter.config.forceCleanSession === 'keep') {
                    client.cleanSession = false;
                } else {
                    client.cleanSession = options.cleanSession === undefined ? options.cleanSession : options.clean;
                }

                client._keepalive = options.keepalive;

                // get possible an old client
                const oldClient = clients[client.id];

                if (config.user) {
                    if (config.user !== options.username ||
                        config.pass !== (options.password || '').toString()) {
                        adapter.log.warn(`Client [${client.id}] has invalid password(${options.password}) or username(${options.username})`);
                        client.authenticated = false;
                        client.connack({returnCode: 4});
                        if (oldClient) {
                            // delete existing client
                            delete clients[client.id];
                            updateClients();
                            oldClient.destroy();
                        }
                        client.destroy();
                        return;
                    } else {
                        client.authenticated = true;
                    }
                }

                if (oldClient) {
                    adapter.log.info(`Client [${client.id}] reconnected. Old secret ${clients[client.id].__secret}. New secret ${client.__secret}`);
                    // need to destroy the old client

                    if (client.__secret !== clients[client.id].__secret) {
                        // it is another socket!!

                        // It was following situation:
                        // - old connection was active
                        // - new connection is on the same TCP
                        // Just forget him
                        // oldClient.destroy();
                    }
                } else {
                    adapter.log.info(`Client [${client.id}] connected with secret ${client.__secret}`);
                }

                let sessionPresent = false;

                if (!client.cleanSession && adapter.config.storeClientsTime !== 0) {
                    if (persistentSessions[client.id]) {
                        sessionPresent = true;
                        persistentSessions[client.id].lastSeen = Date.now();
                    } else {
                        persistentSessions[client.id] = {
                            _subsID: {},
                            _subs: {},
                            messages: [],
                            lastSeen: Date.now(),
                        };
                    }
                    client._messages = persistentSessions[client.id].messages || [];
                    persistentSessions[client.id].connected = true;
                } else if (client.cleanSession && persistentSessions[client.id]) {
                    delete persistentSessions[client.id];
                }
                client._messages = client._messages || [];

                client.connack({returnCode: 0, sessionPresent});
                clients[client.id] = client;
                updateClients();

                if (options.will) { // the client's will message options. object that supports the following properties:
                    // topic:   the will topic. string
                    // payload: the will payload. string
                    // qos:     will qos level. number
                    // retain:  will retain flag. boolean
                    client._will = JSON.parse(JSON.stringify(options.will));
                    let id;
                    if (topic2id[client._will.topic]) {
                        id = topic2id[client._will.topic].id || convertTopic2id(client._will.topic, false, config.prefix, adapter.namespace);
                    } else {
                        id = convertTopic2id(client._will.topic, false, config.prefix, adapter.namespace);
                    }
                    checkObject(id, client._will.topic, options.will.payload)
                        .then(() => {
                            // something went wrong while JSON.parse, so the payload of last will not be handled correct as buffer
                            client._will.payload = options.will.payload;
                            adapter.log.debug(`Client [${client.id}] with last will ${JSON.stringify(client._will)}`);
                        }).catch(err => adapter.log.info(err.message));
                }

                // Send all subscribed variables to a client
                if (config.publishAllOnStart) {
                    // Give to client 2 seconds to send subscribe
                    client._sendOnStart = setTimeout(() => {
                        client._sendOnStart = null;
                        sendStates2Client(client, Object.keys(states));
                    }, adapter.config.sendOnStartInterval);
                }

                if (persistentSessions[client.id]) {
                    client._subsID = persistentSessions[client.id]._subsID;
                    client._subs = persistentSessions[client.id]._subs;
                    if (persistentSessions[client.id].messages.length) {
                        // give to the client a little bit time
                        client._resendonStart = setTimeout(clientId => {
                            client._resendonStart = null;
                            persistentSessions[clientId] && resendMessages2Client(client, persistentSessions[clientId].messages);
                        }, 100, client.id);
                    }
                }

                //set timeout for stream to 1,5 times keepalive [MQTT-3.1.2-24].
                if (!ws && client._keepalive !== 0) {
                    const streamTimeoutSec = 1.5 * client._keepalive;
                    stream.setTimeout(streamTimeoutSec * 1000);

                    adapter.log.debug(`Client [${client.id}] with keepalive ${client._keepalive} set timeout to ${streamTimeoutSec} seconds`);
                }
            });

            // only when we are the RECEIVER of the message
            client.on('publish', async packet => {
                if (!validateRequest('publish', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received publish package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                if (packet.qos === 1) {
                    // send PUBACK to a client
                    client.puback({messageId: packet.messageId});
                } else if (packet.qos === 2) {
                    const pack = client._messages && client._messages.find(e => e.messageId === packet.messageId);
                    if (pack) {
                        // duplicate message => ignore
                        adapter.log.info(`Client [${client.id}] Ignored duplicate message with ID: ${packet.messageId}`);
                        return;
                    } else {
                        packet.ts = Date.now();
                        packet.cmd = 'pubrel';
                        packet.count = 0;
                        client._messages = client._messages || [];
                        client._messages.push(packet);

                        client.pubrec({messageId: packet.messageId});
                        return;
                    }
                }

                await receivedTopic(packet, client);
            });

            // response for QoS2
            // only when we are the SENDER of the message
            client.on('pubrec', packet => {
                if (!validateRequest('pubrec', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received pubrec package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                // remove this message from queue
                const frame = client._messages && client._messages.find(e => e.messageId === packet.messageId);
                if (frame) {
                    client.pubrel({messageId: packet.messageId});
                } else {
                    adapter.log.info(`Client [${client.id}] Received pubrec on ${client.id} for unknown messageId ${packet.messageId}`);
                }
            });

            // response for QoS2
            // only when we are the SENDER of the message
            client.on('pubcomp', packet => {
                if (!validateRequest('pubcomp', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received pubcomp package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                let pos = -1;
                // remove this message from queue
                if (client._messages) {
                    pos = client._messages.findIndex(e => e.messageId === packet.messageId);
                }
                if (pos !== -1) {
                    client._messages.splice(pos, 1);
                } else {
                    adapter.log.info(`Client [${client.id}] Received pubcomp for unknown message ID: ${packet.messageId}`);
                }
            });

            // response for QoS2
            // only when we are the RECEIVER of the message
            client.on('pubrel', async packet => {
                if (!validateRequest('pubrel', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received pubrel package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                // remove this message from queue
                let pos = -1;
                // remove this message from queue
                if (client._messages) {
                    pos = client._messages.findIndex(e => e.messageId === packet.messageId);
                }
                if (pos !== -1) {
                    client.pubcomp({messageId: packet.messageId});
                    await receivedTopic(client._messages[pos], client);
                    client._messages.splice(pos, 1);
                } else {
                    adapter.log.info(`Client [${client.id}] Received pubrel for unknown message ID: ${packet.messageId}`);
                }
            });

            // response for QoS1
            client.on('puback', packet => {
                if (!validateRequest('puback', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received puback package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                // remove this message from queue
                let pos = -1;
                // remove this message from queue
                if (client._messages) {
                    pos = client._messages.findIndex(e => e.messageId === packet.messageId);
                }
                if (pos !== -1) {
                    adapter.log.debug(`Client [${client.id}] Received puback for ${client.id} message ID: ${packet.messageId}`);
                    client._messages.splice(pos, 1);
                } else {
                    adapter.log.info(`Client [${client.id}] Received puback for unknown message ID: ${packet.messageId}`);
                }
            });

            client.on('subscribe', async packet => {
                if (!validateRequest('subscribe', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received subscribe package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                const granted = [];
                client._subsID = client._subsID || {};
                client._subs   = client._subs || {};

                for (let i = 0; i < packet.subscriptions.length; i++) {
                    adapter.log.debug(`Client [${client.id}] Handle subscribe: ${JSON.stringify(packet.subscriptions[i])}`);
                    granted.push(packet.subscriptions[i].qos);

                    const topic = packet.subscriptions[i].topic;
                    let id;

                    if (topic2id[topic]) {
                        id = topic2id[topic].id || convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    } else {
                        id = convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    }

                    if (!id) {
                        adapter.log.error(`Client [${client.id}] Invalid topic: ${topic}`);
                        continue;
                    }

                    // if pattern without wildcards
                    if (!id.includes('*') && !id.includes('#') && !id.includes('+')) {
                        // If state is unknown => create mqtt.X.topic
                        if (!topic2id[topic]) {
                            try {
                                await checkObject(id, topic);
                            } catch (err) {
                                return;
                            }
                        }

                        client._subsID[topic2id[topic].id] = {id: topic2id[topic].id, qos: packet.subscriptions[i].qos};
                        adapter.log.info(`Client [${client.id}] subscribes on "${topic2id[topic].id}"`);

                        if (adapter.config.publishOnSubscribe) {
                            setTimeout(() => {
                                adapter.log.info(`Client [${client.id}] publishOnSubscribe`);
                                sendState2Client(client, topic2id[topic].id, states[topic2id[topic].id]);
                            }, 200);
                        }
                    } else {
                        let pattern = topic;
                        // remove prefix
                        if (pattern.startsWith(adapter.config.prefix)) {
                            pattern = pattern.substring(adapter.config.prefix.length);
                        }
                        pattern = pattern.replace(/\//g, '.');
                        if (pattern[0] === '.') pattern = pattern.substring(1);

                        // add a simple pattern
                        let regText = pattern2RegEx(pattern);
                        client._subs[topic] = {
                            regex:   new RegExp(regText),
                            qos:     packet.subscriptions[i].qos,
                            pattern: pattern
                        };
                        adapter.log.info(`Client [${client.id}] subscribes on "${topic}" with regex /${regText}/`);

                        // add simple mqtt.0.pattern
                        pattern = `${adapter.namespace}/${pattern}`;
                        regText = pattern2RegEx(pattern);
                        client._subs[`${adapter.namespace}/${topic}`] = {
                            regex:   new RegExp(regText),
                            qos:     packet.subscriptions[i].qos,
                            pattern
                        };
                        adapter.log.info(`Client [${client.id}] subscribes on "${topic}"  with regex /${regText}/`);

                        if (adapter.config.publishOnSubscribe) {
                            setTimeout(() => {
                                adapter.log.info(`Client [${client.id}] publishOnSubscribe send all known states`);
                                Object.keys(states).forEach(savedId => {
                                    if (checkPattern(client._subs, savedId)) {
                                        sendState2Client(client, savedId, states[savedId]);
                                    }
                                });
                            }, 200);
                        }
                    }
                }

                client.suback({granted: granted, messageId: packet.messageId});
            });

            client.on('unsubscribe', packet => {
                if (!validateRequest('unsubscribe', client, config)) {
                    return;
                }

                if (adapter.config.debug) {
                    adapter.log.debug(`Client [${client.id}] received unsubscribe package ${JSON.stringify(packet)}`);
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                for (let i = 0; i < packet.unsubscriptions.length; i++) {
                    const topic = packet.unsubscriptions[i];
                    let id;

                    if (topic2id[topic]) {
                        id = topic2id[topic].id || convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    } else {
                        id = convertTopic2id(topic, false, config.prefix, adapter.namespace);
                    }

                    if (!id) {
                        adapter.log.error(`Client [${client.id}] unsubscribes from invalid topic: ${topic}`);
                        continue;
                    }

                    // if pattern without wildcards
                    if (!id.includes('*') && !id.includes('#') && !id.includes('+')) {
                        // If the state is known
                        if (topic2id[topic]) {
                            const _id = topic2id[topic].id;
                            if (client._subsID && client._subsID[_id]) {
                                delete client._subsID[_id];
                                adapter.log.info(`Client [${client.id}] unsubscribes on "${_id}"`);
                            } else {
                                adapter.log.info(`Client [${client.id}] unsubscribes on unknown "${_id}"`);
                            }
                        } else {
                            adapter.log.info(`Client [${client.id}] unsubscribes on unknown topic "${topic}"`);
                        }
                    } else {
                        let pattern = topic.replace(/\//g, '.');
                        if (pattern[0] === '.') {
                            pattern = pattern.substring(1);
                        }

                        // add a simple pattern
                        if (client._subs && client._subs[topic]) {
                            adapter.log.info(`Client [${client.id}] unsubscribes on "${topic}"`);
                            delete client._subs[topic];
                            if (client._subs[`${adapter.namespace}/${topic}`]) {// add simple mqtt.0.pattern
                                delete client._subs[`${adapter.namespace}/${topic}`];
                                adapter.log.info(`Client [${client.id}] unsubscribes on "${adapter.namespace}/${topic}"`);
                            }
                        } else {
                            adapter.log.info(`Client [${client.id}] unsubscribes on unknown "${topic}"`);
                        }
                    }
                }
                client.unsuback({messageId: packet.messageId});
            });

            client.on('pingreq', (/*packet*/) => {
                if (!validateRequest('pingreq', client, config)) {
                    return;
                }

                if (persistentSessions[client.id]) {
                    persistentSessions[client.id].lastSeen = Date.now();
                }

                adapter.log.debug(`Client [${client.id}]  pingreq`);
                client.pingresp();
            });

            // connection error handling
            client.on('close',      hadError => clientClose(client, hadError ? 'closed because of error' : 'closed'));
            client.on('error',      e  => clientClose(client, e));
            client.on('disconnect', () => clientClose(client, 'disconnected'));

            // client lost without a close
            stream.on('timeout', () => clientClose(client, 'timeout'));

        });
        (server || socket).listen(port, bind, () =>
            adapter.log.info(`Starting MQTT${ws ? '-WebSocket' : ''}${ssl ? ' (Secure)' : ''}${config.user ? ' authenticated' : ''} server on ${bind || '0.0.0.0'}:${port}`)).on('error', err => adapter.log.error(`Error starting MQTT${ws ? '-WebSocket' : ''}${ssl ? ' (Secure)' : ''}${config.user ? ' authenticated' : ''} server on ${bind || '0.0.0.0'}:${port}: ${err}`));
    }

    function checkResends() {
        const now = Date.now();
        resending = true;
        for (const clientId in clients) {
            if (Object.prototype.hasOwnProperty.call(clients, clientId) && clients[clientId] && clients[clientId]._messages) {
                for (let m = clients[clientId]._messages.length - 1; m >= 0; m--) {
                    const message = clients[clientId]._messages[m];
                    if (now - message.ts >= adapter.config.retransmitInterval) {
                        if (message.count > adapter.config.retransmitCount) {
                            adapter.log.warn(`Client [${clientId}] Message ${message.messageId} deleted after ${message.count} retries`);
                            clients[clientId]._messages.splice(m, 1);
                            continue;
                        }

                        // resend this message
                        message.count++;
                        message.ts = now;
                        try {
                            adapter.log.debug(`Client [${clientId}] Resend for ${message.cmd} message topic: ${message.topic}, payload: ${message.payload}`);
                            if (message.cmd === 'publish') {
                                message.dup = true;
                                clients[clientId].publish(message);
                            } else if (message.cmd === 'pubrel') {
                                clients[clientId].pubrec({
                                    messageId: message.messageId
                                });
                            }
                        } catch (e) {
                            adapter.log.warn(`Client [${clientId}] Cannot publish message: ${e}`);
                        }

                        if (adapter.config.sendInterval) {
                            setTimeout(checkResends, adapter.config.sendInterval);
                        } else {
                            setImmediate(checkResends);
                        }
                        return;
                    }
                }
            }
        }

        // delete old sessions
        if (adapter.config.storeClientsTime !== -1) {
            Object.keys(persistentSessions).forEach(id => {
                if (!persistentSessions[id] || now - persistentSessions[id].lastSeen > adapter.config.storeClientsTime * 60000) {
                    delete persistentSessions[id];
                }
            });
        }

        resending = false;
    }

    (function _constructor(config) {
        // create connected object and state
        adapter.getObject('info.connection', (err, obj) => {
            if (!obj || !obj.common || obj.common.type !== 'string') {
                obj = {
                    _id:  'info.connection',
                    type: 'state',
                    common: {
                        role:  'info.clients',
                        name:  {
                            en: 'List of connected clients',
                            de: 'Liste der verbundenen Clients',
                            ru: 'Список подключенных клиентов',
                            it: 'Elenco dei client connessi',
                            es: 'Lista de clientes conectados',
                            pt: 'Lista de clientes conectados',
                            nl: 'Lijst van verbonden clients',
                            fr: 'Liste des clients connectés',
                            pl: 'Lista podłączonych klientów',
                            uk: 'Список підключених клієнтів',
                            'zh-cn': '已连接客户端的列表',
                        },
                        type:  'string',
                        read:  true,
                        write: false,
                        def:   '',
                    },
                    native: {},
                };

                adapter.setObject('info.connection', obj, () => updateClients());
            } else {
                updateClients();
            }
        });

        config.port = parseInt(config.port, 10) || 1883;
        if (config.port < 0 || config.port > 65535) {
            adapter.log.error(`Port ${config.port} is invalid, using 1883.`);
            config.port = 1883;
        }
        config.retransmitInterval = config.retransmitInterval || 2000;
        config.retransmitCount = config.retransmitCount || 10;
        if (config.storeClientsTime === undefined) {
            config.storeClientsTime = 1440;
        } else {
            config.storeClientsTime = parseInt(config.storeClientsTime, 10) || 0;
        }

        config.defaultQoS = parseInt(config.defaultQoS, 10) || 0;

        if (config.ssl) {
            net = net || require('tls');
            if (config.webSocket) {
                http = http || require('https');
            }
        } else {
            net = net || require('net');
            if (config.webSocket) {
                http = http || require('http');
            }
        }

        try {
            server = new net.Server(config.certificates);
        } catch (err) {
            adapter.log.error(`Cannot create server: ${err}`);
            adapter.terminate ? adapter.terminate(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            return;
        }
        server.on('error', err => {
            adapter.log.error(`Cannot create server: ${err}`);
            adapter.terminate ? adapter.terminate(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
        });

        try {
            startServer(config, server, null, config.port, config.bind, config.ssl, false);
        } catch (err) {
            adapter.log.error(`Cannot create server: ${err}`);
            adapter.terminate ? adapter.terminate(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            return;
        }
        if (config.webSocket) {
            http        = http     || require('https');
            ws          = ws       || require('ws');
            wsStream    = wsStream || require('websocket-stream');
            serverForWs = http.createServer(config.certificates);
            serverWs    = new ws.Server({server: serverForWs});

            try {
                startServer(config, serverWs, serverForWs, config.port + 1, config.bind, config.ssl, true);
            } catch (err) {
                adapter.log.error(`Cannot create server: ${err}`);
                adapter.terminate ? adapter.terminate(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(adapter.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
        }

        resendTimer = setInterval(() =>
            !resending && checkResends(), adapter.config.retransmitInterval || 2000);

    })(adapter.config);

    return this;
}

module.exports = MQTTServer;
