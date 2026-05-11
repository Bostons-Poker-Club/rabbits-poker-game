'use strict';
// Shared in-process event bus — lets api.js emit events that handlers.js forwards over sockets
const EventEmitter = require('events');
module.exports = new EventEmitter();
