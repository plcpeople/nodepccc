// nodepccc - A library for communication to some AB PLCs from node.js.  

// The MIT License (MIT)

// Copyright (c) 2014 Dana Moffit

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// EXTRA WARNING - This is BETA software and as such, be careful, especially when 
// writing values to programmable controllers.
//
// Some actions or errors involving programmable controllers can cause injury or death, 
// and YOU are indicating that you understand the risks, including the 
// possibility that the wrong address will be overwritten with the wrong value, 
// when using this library.  Test thoroughly in a laboratory environment, even for read-
// only applications.

var net = require("net");
var _ = require("underscore");
var util = require("util");
var effectiveDebugLevel = 0; // intentionally global, shared between connections

module.exports = NodePCCC;

function NodePCCC(){
	var self = this;
	self.connectReq   = new Buffer([0x65,0x00,0x04,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x0a,0x0b,0x0c,0x0d,0x0e,0x0f,0x0a,0x0b,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00]);
							
	// This header is used to assemble a read packet.
	self.EIP_CIP_Header = new Buffer([0x6f,0x00,0x27,0x00,0x00,0x03,0x02,0x00,0x00,0x00,  // third is length
								0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x28,0x1e,0x4d,
								0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x0a,0x00, //a -> 0
								0x02,0x00,0x00,0x00,0x00,0x00,0xb2,0x00,0x17,0x00]);//, // second last is length

	// The routing header is only needed when a connection path is specified
	self.Routing_Header = new Buffer([0x52, // CIP Connection manager service = unconnected send
								0x02,0x20,0x06,0x24,0x01, // 0x02 = 2 words in path, 0x2006 = logical segment, class 6 = connection manager, 0x2401 = logical segment, instance 1
								0x0a,0x09, // Priority/ticks multiplier, 0x0a = normal priority, 0x09 = about 10 second timeout given 0x0a priority
								0x20,0x00]); // Length of message that follows - adjusted accordingly

	// The connection path is normally specified externally as it is used for ControlLogix applications generally
	self.Connection_Path = new Buffer([]); // new Buffer([0x01,0x00,0x01,0x00]);  // This means 1 word length of path, 0x01 = backplane port of ethernet module, 0x00 = slot 0 of backplane.  
							
	// This is the PCCC command.
	self.PCCC_Encapsulation_Header = new Buffer([0x4b,0x02, // 4b = "execute PCCC", 02 = 2 words in the path. 
							0x20,0x67,0x24,0x01, //,  // 20,67,24,01 = the path.  (Class PCCC, instance 1, just don't worry about it.)
							0x07,0x00,0x00,0x01,0x02,0x03,0x04, // 0x07 = 7 byte vendor string length (including the length), 0x00, 0x00 = CIP vendor ID, 01020304 = serial number.   
								0x0f,0x00,	// PCCC command = 0x0f, 0x00 is the status for request
								0x12,0x34]);  // transaction ID, gets echoed back to us									

	self.readReq = new Buffer(1500);
	self.writeReq = new Buffer(1500);

	self.resetPending = false;
	self.resetTimeout = undefined;

	self.sendpdu = false;
	self.isoclient = undefined; 
	self.isoConnectionState = 0;
	self.requestMaxPDU = 220; // 225 read, 223 write, from DF1 manual.  MAY not 
	self.maxPDU = 220;
	self.requestMaxParallel = 4;
	self.maxParallel = 4;
	self.parallelJobsNow = 0;
	self.maxGap = 5;
	self.doNotOptimize = false;
	self.connectCallback = undefined;
	self.readDoneCallback = undefined;
	self.writeDoneCallback = undefined;
	self.connectTimeout = undefined; 
	self.PDUTimeout = undefined;
	self.globalTimeout = 4500;

	self.readPacketArray = [];
	self.writePacketArray = [];
	self.polledReadBlockList = [];
	self.instantWriteBlockList = [];
	self.globalReadBlockList = [];
	self.globalWriteBlockList = [];
	self.masterSequenceNumber = 1;
	self.translationCB = doNothing;
	self.connectionParams = undefined;
	self.connectionID = 'UNDEF';
	self.addRemoveArray = [];
	self.readPacketValid = false;
	self.writeInQueue = false;
	self.connectCBIssued = false;

// EIP specific
	self.sessionHandle = 0; // Define as zero for when we write packets prior to connection
}

NodePCCC.prototype.setTranslationCB = function(cb) {
	var self = this;
	if (typeof cb === "function") { 
		outputLog('Translation OK');
		self.translationCB = cb; 
	}
}

NodePCCC.prototype.initiateConnection = function (cParam, callback) {
	var self = this;
	if (cParam === undefined) { cParam = {port: 44818, host: '192.168.8.106'}; }
	outputLog('Initiate Called - Connecting to PLC with address and parameters:');
	outputLog(cParam);
	if (typeof(cParam.name) === 'undefined') {
		self.connectionID = cParam.host;
	} else {
		self.connectionID = cParam.name;		
	}
	if (typeof(cParam.routing) !== 'undefined') {
		self.Connection_Path = new Buffer(cParam.routing);  // We can't use the name 'path' if we pass into connect function or nothing works.
	}
	self.connectionParams = cParam;
	self.connectCallback = callback;
	self.connectCBIssued = false;
	self.connectNow(self.connectionParams, false);
}

NodePCCC.prototype.dropConnection = function () {
	var self = this;
	if (typeof(self.isoclient) !== 'undefined') {
		self.isoclient.end();
	}		
	self.connectionCleanup();  // TODO - check this.
}

NodePCCC.prototype.connectNow = function(cParam, suppressCallback) { // TODO - implement or remove suppressCallback
	var self = this;
	// Don't re-trigger.
	if (self.isoConnectionState >= 1) { return; }
	self.connectionCleanup();
	self.isoclient = net.connect(cParam, function(){
		self.onTCPConnect.apply(self,arguments);
	});
	
	self.isoConnectionState = 1;  // 1 = trying to connect
    
	self.isoclient.on('error', function(){
		self.connectError.apply(self, arguments);
	});
	
	outputLog('<initiating a new connection>',1,self.connectionID);  
	outputLog('Attempting to connect to host...',0,self.connectionID);
}

NodePCCC.prototype.connectError = function(e) {
	var self = this;
	
	// Note that a TCP connection timeout error will appear here.  An ISO connection timeout error is a packet timeout.  
	outputLog('We Caught a connect error ' + e.code,0,self.connectionID);
	if ((!self.connectCBIssued) && (typeof(self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback(e);
	}
	self.isoConnectionState = 0;
}

NodePCCC.prototype.readWriteError = function(e) {
	var self = this;
	outputLog('We Caught a read/write error ' + e.code + ' - resetting connection',0,self.connectionID);
	self.isoConnectionState = 0;
	self.connectionReset();
}

NodePCCC.prototype.packetTimeout = function(packetType, packetSeqNum) {
	var self = this;
	outputLog('PacketTimeout called with type ' + packetType + ' and seq ' + packetSeqNum,1,self.connectionID); 
	if (packetType === "connect") {
		outputLog("TIMED OUT waiting for EIP Connection Response from the PLC - Disconnecting",0,self.connectionID);
		outputLog("Wait for 2 seconds then try again.",0,self.connectionID);		
		self.connectionReset();
		outputLog("Scheduling a reconnect from packetTimeout, connect type",0,self.connectionID);
		setTimeout(function(){
			outputLog("The scheduled reconnect from packetTimeout, connect type, is happening now",0,self.connectionID);
			self.connectNow.apply(self,arguments);
		}, 2000, self.connectionParams);
		return undefined;
	}
	if (packetType === "read") {
		outputLog("READ TIMEOUT on sequence number " + packetSeqNum,0,self.connectionID);
		self.readResponse(undefined, self.findReadIndexOfSeqNum(packetSeqNum));
		return undefined;
	}
	if (packetType === "write") {
		outputLog("WRITE TIMEOUT on sequence number " + packetSeqNum,0,self.connectionID);
		self.writeResponse(undefined, self.findWriteIndexOfSeqNum(packetSeqNum));
		return undefined;
	}	
	outputLog("Unknown timeout error.  Nothing was done - this shouldn't happen.",0,self.connectionID);
}

NodePCCC.prototype.onTCPConnect = function() {
	var self = this;
	outputLog('TCP Connection Established to ' + self.isoclient.remoteAddress + ' on port ' + self.isoclient.remotePort + ' - Will attempt EIP Connection',0,self.connectionID);

	// Track the connection state
	self.isoConnectionState = 2;  // 2 = TCP connected, wait for EIP connection confirmation
	
	// Send an EIP connection request.  
	self.connectTimeout = setTimeout(function(){
		self.packetTimeout.apply(self,arguments);
		}, self.globalTimeout, "connect");
		
	self.isoclient.write(self.connectReq.slice(0,28));

	// Listen for a reply.
	self.isoclient.on('data',function() {
		self.onEIPConnectReply.apply(self, arguments);
	});
		
	// Hook up the event that fires on disconnect
	self.isoclient.on('end',function() {
		self.onClientDisconnect.apply(self, arguments);
	});
}

NodePCCC.prototype.onEIPConnectReply = function(data) {
	var self = this;
 	self.isoclient.removeAllListeners('data');
	self.isoclient.removeAllListeners('error');
	
	clearTimeout(self.connectTimeout);
	
	// Track the connection state
	self.isoConnectionState = 4;  // 4 = Good to go.  (No PDU with EIP so 3 is an invalid state) 
	
	// First we check our error code in the EIP section.  
	if (data[8] !== 0x00 || data[9] !== 0x00 || data[10] !== 0x00 || data[11] !== 0x00) {
		outputLog('ERROR RECEIVED IN REGISTER SESSION RESPONSE PACKET - DISCONNECTING');
		outputLog(data);
		outputLog('Codes are ' + data[8] + " " + data[9] + " " + data[10] + " " + data[11]); 
		self.connectionReset();
		return null;
	}

	// Do we check our context here?  
	// Let's not bother.
	
	// Expected length is from packet sniffing - some applications may be different - not considered yet.
	if (data[0] !== 0x65 || data[2] !== 0x04 || data.length < 28) { 
		outputLog('INVALID PACKET or CONNECTION REFUSED - DISCONNECTING');
		outputLog(data);
		outputLog('RCV buffer length is ' + data.length + 'data[0] is ' + data[0] + ' and data[2] is ' + data[2]); 
		self.connectionReset();
		return null;
	}

	outputLog('EIP Register Session Response Received - connection confirmed',0,self.connectionID);
	
	self.sessionHandle = data.readInt32LE(4);  // Not BE
	
	outputLog("Session Handle is " + decimalToHexString(self.sessionHandle),0,self.connectionID);
	
	self.isoclient.on('data', function() {
		self.onResponse.apply(self, arguments);
	});  // We need to make sure we don't add this event every time if we call it on data.  
	self.isoclient.on('error', function() {
		self.readWriteError.apply(self, arguments);
	});  // Might want to remove the connecterror listener

	if ((!self.connectCBIssued) && (typeof(self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback();
	}

	return;
}


NodePCCC.prototype.writeItems = function(arg, value, cb) {
	var self = this;
	var i;
	outputLog("Preparing to WRITE " + arg,0,self.connectionID);

	if (self.isWriting()) {
		outputLog("You must wait until all previous writes have finished before scheduling another. ",0,self.connectionID); 
		return; 
	}
	
	if (typeof cb === "function") {
		self.writeDoneCallback = cb;
	} else {
		self.writeDoneCallback = doNothing;
	}
	
	self.instantWriteBlockList = []; // Initialize the array.  
	
	if (typeof arg === "string") { 
		self.instantWriteBlockList.push(stringToSLCAddr(self.translationCB(arg), arg));
		if (typeof(self.instantWriteBlockList[self.instantWriteBlockList.length - 1]) !== "undefined") {
			self.instantWriteBlockList[self.instantWriteBlockList.length - 1].writeValue = value;
		}
	} else if (_.isArray(arg) && _.isArray(value) && (arg.length == value.length)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof arg[i] === "string") {
				self.instantWriteBlockList.push(stringToSLCAddr(self.translationCB(arg[i]), arg[i]));
				if (typeof(self.instantWriteBlockList[self.instantWriteBlockList.length - 1]) !== "undefined") {
					self.instantWriteBlockList[self.instantWriteBlockList.length - 1].writeValue = value[i];
				}				
			}
		}
	}
	
	// Validity check.  
	for (i=self.instantWriteBlockList.length-1;i>=0;i--) {
		if (self.instantWriteBlockList[i] === undefined) {
			self.instantWriteBlockList.splice(i,1);
			outputLog("Dropping an undefined write item.");
		}
	}
	self.prepareWritePacket();
	if (!self.isReading()) { 
		self.sendWritePacket(); 
	} else {
		self.writeInQueue = true;
	}
}


NodePCCC.prototype.findItem = function(useraddr) {
	var self = this;
	var i;
	var commstate = { value: self.isoConnectionState !== 4, quality: 'OK' };
	if (useraddr === '_COMMERR') { return commstate; }
	for (i = 0; i < self.polledReadBlockList.length; i++) {
		if (self.polledReadBlockList[i].useraddr === useraddr) { return self.polledReadBlockList[i]; } 
	}
	return undefined;
}

NodePCCC.prototype.addItems = function(arg) {
	var self = this;
	self.addRemoveArray.push({arg: arg, action: 'add'});
}

NodePCCC.prototype.addItemsNow = function(arg) {
	var self = this;
	var i;
	outputLog("Adding " + arg,0,self.connectionID);
	addItemsFlag = false;
	if (typeof arg === "string") { 
		self.polledReadBlockList.push(stringToSLCAddr(self.translationCB(arg), arg));
	} else if (_.isArray(arg)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof arg[i] === "string") {
				self.polledReadBlockList.push(stringToSLCAddr(self.translationCB(arg[i]), arg[i]));
			}
		}
	}
	
	// Validity check.  
	for (i=self.polledReadBlockList.length-1;i>=0;i--) {
		if (self.polledReadBlockList[i] === undefined) {
			self.polledReadBlockList.splice(i,1);
			outputLog("Dropping an undefined request item.");
		}
	}
//	prepareReadPacket();
	self.readPacketValid = false;
}

NodePCCC.prototype.removeItems = function(arg) {
	var self = this;
	self.addRemoveArray.push({arg : arg, action: 'remove'});
}

NodePCCC.prototype.removeItemsNow = function(arg) {
	var self = this;
	var i;
	self.removeItemsFlag = false;
	if (typeof arg === "undefined") {
		self.polledReadBlockList = [];
	} else if (typeof arg === "string") {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			outputLog('TCBA ' + self.translationCB(arg));
			if (self.polledReadBlockList[i].addr === self.translationCB(arg)) {
				outputLog('Splicing');
				self.polledReadBlockList.splice(i, 1);
			}
		}
	} else if (_.isArray(arg)) {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			for (j = 0; j < arg.length; j++) {
				if (self.polledReadBlockList[i].addr === self.translationCB(arg[j])) {
					self.polledReadBlockList.splice(i, 1);
				}
			}
		}
	}
	self.readPacketValid = false;
	//	prepareReadPacket();
}

NodePCCC.prototype.readAllItems = function(arg) {
	var self = this;
	var i;

	outputLog("Reading All Items (readAllItems was called)",1,self.connectionID);
	
	if (typeof arg === "function") {
		self.readDoneCallback = arg;
	} else {
		self.readDoneCallback = doNothing;
	}	
	
	if (self.isoConnectionState !== 4) { 
		outputLog("Unable to read when not connected. Return bad values.",0,self.connectionID);
	} // For better behaviour when auto-reconnecting - don't return now
	
	// Check if ALL are done...  You might think we could look at parallel jobs, and for the most part we can, but if one just finished and we end up here before starting another, it's bad.
	if (self.isWaiting()) { 
		outputLog("Waiting to read for all R/W operations to complete.  Will re-trigger readAllItems in 100ms."); 
		setTimeout(function() {
			self.readAllItems.apply(self, arguments);
		}, 100, arg); 
		return;
	}
	
	// Now we check the array of adding and removing things.  Only now is it really safe to do this.  
	self.addRemoveArray.forEach(function(element){
		outputLog('Adding or Removing ' + util.format(element), 1, self.connectionID);
		if (element.action === 'remove') {
			self.removeItemsNow(element.arg);
		} 
		if (element.action === 'add') {
			self.addItemsNow(element.arg);
		}
	});
	
	self.addRemoveArray = []; // Clear for next time.  
	
	if (!self.readPacketValid) { self.prepareReadPacket(); }
	
	// ideally...  incrementSequenceNumbers();
	
	outputLog("Calling SRP from RAI",1,self.connectionID);
	self.sendReadPacket(); // Note this sends the first few read packets depending on parallel connection restrictions.   
}

NodePCCC.prototype.isWaiting = function() {
	var self = this;
	return (self.isReading() || self.isWriting());
}

NodePCCC.prototype.isReading = function() {
	var self = this;
	var i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i=0; i<self.readPacketArray.length; i++) {
		if (self.readPacketArray[i].sent === true) { return true };  
	}
	return false;
}

NodePCCC.prototype.isWriting = function() {
	var self = this;
	var i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i=0; i<self.writePacketArray.length; i++) {
		if (self.writePacketArray[i].sent === true) { return true }; 
	}	
	return false;
}


NodePCCC.prototype.clearReadPacketTimeouts = function() {
	var self = this;
	outputLog('Clearing read PacketTimeouts',1,self.connectionID);
	// Before we initialize the readPacketArray, we need to loop through all of them and clear timeouts.  
	for (i=0;i<self.readPacketArray.length;i++) {
		clearTimeout(self.readPacketArray[i].timeout);
		self.readPacketArray[i].sent = false;
		self.readPacketArray[i].rcvd = false;
	}
}

NodePCCC.prototype.clearWritePacketTimeouts = function() {
	var self = this;
	outputLog('Clearing write PacketTimeouts',1,self.connectionID);
	// Before we initialize the readPacketArray, we need to loop through all of them and clear timeouts.  
	for (i=0;i<self.writePacketArray.length;i++) {
		clearTimeout(self.writePacketArray[i].timeout);
		self.writePacketArray[i].sent = false;
		self.writePacketArray[i].rcvd = false;
	}
}

NodePCCC.prototype.prepareWritePacket = function() {
	var self = this;
	var itemList = self.instantWriteBlockList;
	var requestList = [];			// The request list consists of the block list, split into chunks readable by PDU.  
	var requestNumber = 0;
	var itemsThisPacket;
	var numItems;
	
	// Sort the items using the sort function, by type and offset.  
	itemList.sort(itemListSorter);
	
	// Just exit if there are no items.  
	if (itemList.length == 0) {
		return undefined;
	}
	
	// At this time we do not do write optimizations.  
	// The reason for this is it is would cause numerous issues depending how the code was written in the PLC.
	// If we write B3:0/0 and B3:0/1 then to optimize we would have to write all of B3:0, which also writes /2, /3...
	//
	// I suppose when working with integers, we could write these as one block.  
	// But if you really, really want the program to do that, write an array yourself and it will.  
	self.globalWriteBlockList[0] = itemList[0];
	self.globalWriteBlockList[0].itemReference = [];
	self.globalWriteBlockList[0].itemReference.push(itemList[0]);
	
	var thisBlock = 0;
	itemList[0].block = thisBlock;
	var maxByteRequest = 4*Math.floor((self.maxPDU - 18 - 12)/4);  // Absolutely must not break a real array into two requests.  Maybe we can extend by two bytes when not DINT/REAL/INT.  
//	outputLog("Max Write Length is " + maxByteRequest);
	
	// Just push the items into blocks and figure out the write buffers
	for (i=0;i<itemList.length;i++) {
		self.globalWriteBlockList[i] = itemList[i]; // Remember - by reference.  
		self.globalWriteBlockList[i].isOptimized = false;
		self.globalWriteBlockList[i].itemReference = [];
		self.globalWriteBlockList[i].itemReference.push(itemList[i]);
		bufferizePCCCItem(itemList[i]);
//		outputLog("Really Here");
	}
		
//	outputLog("itemList0 wb 0 is " + itemList[0].writeBuffer[0] + " gwbl is " + globalWriteBlockList[0].writeBuffer[0]);
		
	var thisRequest = 0;
	
	// Split the blocks into requests, if they're too large.  
	for (i=0;i<self.globalWriteBlockList.length;i++) {
		var startElement = self.globalWriteBlockList[i].offset;
		var remainingLength = self.globalWriteBlockList[i].byteLength;
		var lengthOffset = 0;

		// Always create a request for a globalReadBlockList. 
		requestList[thisRequest] = self.globalWriteBlockList[i].clone();
		
		// How many parts?
		self.globalWriteBlockList[i].parts = Math.ceil(self.globalWriteBlockList[i].byteLength/maxByteRequest);
//		outputLog("globalWriteBlockList " + i + " parts is " + globalWriteBlockList[i].parts + " offset is " + globalWriteBlockList[i].offset + " MBR is " + maxByteRequest);
		
		self.globalWriteBlockList[i].requestReference = [];
		
		// If we're optimized... 
		for (j=0;j<self.globalWriteBlockList[i].parts;j++) {
			requestList[thisRequest] = self.globalWriteBlockList[i].clone();
			self.globalWriteBlockList[i].requestReference.push(requestList[thisRequest]);
			requestList[thisRequest].offset = startElement;
			requestList[thisRequest].byteLength = Math.min(maxByteRequest,remainingLength);
			requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].byteLength;
			if (requestList[thisRequest].byteLengthWithFill % 2) { requestList[thisRequest].byteLengthWithFill += 1; };

			// max
//			outputLog("LO " + lengthOffset + " rblf " + requestList[thisRequest].byteLengthWithFill + " val " + globalWriteBlockList[i].writeBuffer[0]);
			requestList[thisRequest].writeBuffer = self.globalWriteBlockList[i].writeBuffer.slice(lengthOffset, lengthOffset + requestList[thisRequest].byteLengthWithFill);  
			requestList[thisRequest].writeQualityBuffer = self.globalWriteBlockList[i].writeQualityBuffer.slice(lengthOffset, lengthOffset + requestList[thisRequest].byteLengthWithFill);  
			lengthOffset += self.globalWriteBlockList[i].requestReference[j].byteLength;

			if (self.globalWriteBlockList[i].parts > 1) {
				requestList[thisRequest].datatype = 'BYTE';
				requestList[thisRequest].dtypelen = 1;
				requestList[thisRequest].arrayLength = requestList[thisRequest].byteLength;//globalReadBlockList[thisBlock].byteLength;		(This line shouldn't be needed anymore - shouldn't matter)
			}
			remainingLength -= maxByteRequest;
			startElement += maxByteRequest/requestList[thisRequest].multidtypelen;			
			thisRequest++;
		}		
	}

	self.clearWritePacketTimeouts(); 	
	self.writePacketArray = [];

//	outputLog("RLL is " + requestList.length);

 
	// Before we initialize the writePacketArray, we need to loop through all of them and clear timeouts.  
	// The packetizer...

	while (requestNumber < requestList.length) {
		// Set up the read packet
		// Yes this is the same master sequence number shared with the read queue
		self.masterSequenceNumber += 1;
		if (self.masterSequenceNumber > 32767) {
			self.masterSequenceNumber = 1;
		}
		
		numItems = 0;
		
		// Packet's length 
		var packetWriteLength = 10 + 4;  // 10 byte header and 4 byte param header 
			
		self.writePacketArray.push(new PLCPacket());
		var thisPacketNumber = self.writePacketArray.length - 1;
		self.writePacketArray[thisPacketNumber].seqNum = self.masterSequenceNumber;
//		outputLog("Write Sequence Number is " + writePacketArray[thisPacketNumber].seqNum);
	
		self.writePacketArray[thisPacketNumber].itemList = [];  // Initialize as array.  
	
		for (var i = requestNumber; i < requestList.length; i++) {

			if (numItems == 1) {
				break;  // Used to break when packet was full.  Now break when we can't fit this packet in here.  
			}

			requestNumber++;
			numItems++;
			packetWriteLength += (requestList[i].byteLengthWithFill + 4);
			self.writePacketArray[thisPacketNumber].itemList.push(requestList[i]);			
		}
	}
	outputLog("WPAL is " + self.writePacketArray.length, 1);
}


NodePCCC.prototype.prepareReadPacket = function() {
	var self = this;
	var itemList = self.polledReadBlockList;				// The items are the actual items requested by the user
	var requestList = [];						// The request list consists of the block list, split into chunks readable by PDU.  	
	var startOfSlice, endOfSlice;
	
	// Validity check.  
	for (i=itemList.length-1;i>=0;i--) {
		if (itemList[i] === undefined) {
			itemList.splice(i,1);
			outputLog("Dropping an undefined request item.",0,self.connectionID);
		}
	}
	
	// Sort the items using the sort function, by type and offset.  
	itemList.sort(itemListSorter);
	
	// Just exit if there are no items.  
	if (itemList.length == 0) {
		return undefined;
	}
	
	self.globalReadBlockList = [];
	
	// ...because you have to start your optimization somewhere.  
	self.globalReadBlockList[0] = itemList[0];
	self.globalReadBlockList[0].itemReference = [];
	self.globalReadBlockList[0].itemReference.push(itemList[0]);
	
	var thisBlock = 0;
	itemList[0].block = thisBlock;
	var maxByteRequest = 4*Math.floor((self.maxPDU - 18)/4);  // Absolutely must not break a real array into two requests.  Maybe we can extend by two bytes when not DINT/REAL/INT.  
	
	// Optimize the items into blocks
	for (i=1;i<itemList.length;i++) {
		// Skip T, C, P types 
		if ((itemList[i].areaPCCCCode !== self.globalReadBlockList[thisBlock].areaPCCCCode) ||   	// Can't optimize between areas
				(itemList[i].fileNumber !== self.globalReadBlockList[thisBlock].fileNumber) ||			// Can't optimize across DBs
				(!self.isOptimizableArea(itemList[i].areaPCCCCode)) || 					// May as well try to optimize everything.  
				((itemList[i].offset - self.globalReadBlockList[thisBlock].offset + itemList[i].byteLength) > maxByteRequest) ||      	// If this request puts us over our max byte length, create a new block for consistency reasons.
				(itemList[i].offset - (self.globalReadBlockList[thisBlock].offset + self.globalReadBlockList[thisBlock].byteLength) > self.maxGap)) {		// If our gap is large, create a new block.
			// At this point we give up and create a new block.  
			thisBlock = thisBlock + 1;
			self.globalReadBlockList[thisBlock] = itemList[i]; // By reference.  
//				itemList[i].block = thisBlock; // Don't need to do this.  
			self.globalReadBlockList[thisBlock].isOptimized = false;
			self.globalReadBlockList[thisBlock].itemReference = [];
			self.globalReadBlockList[thisBlock].itemReference.push(itemList[i]);
//			outputLog("Not optimizing.");
		} else {
			outputLog("Performing optimization of item " + itemList[i].addr + " with " + self.globalReadBlockList[thisBlock].addr,1);
			// This next line checks the maximum.  
			// Think of this situation - we have a large request of 40 bytes starting at byte 10.  
			//	Then someone else wants one byte starting at byte 12.  The block length doesn't change.
			//
			// But if we had 40 bytes starting at byte 10 (which gives us byte 10-49) and we want byte 50, our byte length is 50-10 + 1 = 41.  
//worked when complicated.			globalReadBlockList[thisBlock].byteLength = Math.max(globalReadBlockList[thisBlock].byteLength, ((itemList[i].offset - globalReadBlockList[thisBlock].offset) + Math.ceil(itemList[i].byteLength/itemList[i].multidtypelen))*itemList[i].multidtypelen);
			self.globalReadBlockList[thisBlock].byteLength = Math.max(self.globalReadBlockList[thisBlock].byteLength, ((itemList[i].offset - self.globalReadBlockList[thisBlock].offset) + Math.ceil(itemList[i].byteLength/itemList[i].multidtypelen))*itemList[i].multidtypelen);

			outputLog("Optimized byte length is now " + self.globalReadBlockList[thisBlock].byteLength,1);
			
//			globalReadBlockList[thisBlock].subelement = 0;  // We can't read just a timer preset, for example, 
			
			// Point the buffers (byte and quality) to a sliced version of the optimized block.  This is by reference (same area of memory)
			startOfSlice = (itemList[i].offset - self.globalReadBlockList[thisBlock].offset)*itemList[i].multidtypelen;
			endOfSlice = startOfSlice + itemList[i].byteLength;
//			outputLog("SOS + EOS " + startOfSlice + " " + endOfSlice);
			itemList[i].byteBuffer = self.globalReadBlockList[thisBlock].byteBuffer.slice(startOfSlice, endOfSlice);
			itemList[i].qualityBuffer = self.globalReadBlockList[thisBlock].qualityBuffer.slice(startOfSlice, endOfSlice);
				
			// For now, change the request type here, and fill in some other things.  

			// I am not sure we want to do these next two steps.
			// It seems like things get screwed up when we do this.
			// Since globalReadBlockList[thisBlock] exists already at this point, and our buffer is already set, let's not do this now.   
			// globalReadBlockList[thisBlock].datatype = 'BYTE';
			// globalReadBlockList[thisBlock].dtypelen = 1;
			self.globalReadBlockList[thisBlock].isOptimized = true;
			self.globalReadBlockList[thisBlock].itemReference.push(itemList[i]);
		}
	}
		
	var thisRequest = 0;
	
//	outputLog("Preparing the read packet...");
	
	// Split the blocks into requests, if they're too large.  
	for (i=0;i<self.globalReadBlockList.length;i++) {
		// Always create a request for a globalReadBlockList. 
		requestList[thisRequest] = self.globalReadBlockList[i].clone();
		
		// How many parts?
		self.globalReadBlockList[i].parts = Math.ceil(self.globalReadBlockList[i].byteLength/maxByteRequest);
//		outputLog("globalReadBlockList " + i + " parts is " + globalReadBlockList[i].parts + " offset is " + globalReadBlockList[i].offset + " MBR is " + maxByteRequest);
		var startElement = self.globalReadBlockList[i].offset;
		var remainingLength = self.globalReadBlockList[i].byteLength;

		self.globalReadBlockList[i].requestReference = [];
		
		// If we're optimized... 
		for (j=0;j<self.globalReadBlockList[i].parts;j++) {
			requestList[thisRequest] = self.globalReadBlockList[i].clone();
			self.globalReadBlockList[i].requestReference.push(requestList[thisRequest]);
			//outputLog(globalReadBlockList[i]);
			//outputLog(globalReadBlockList.slice(i,i+1));
			requestList[thisRequest].offset = startElement;
			requestList[thisRequest].byteLength = Math.min(maxByteRequest,remainingLength);
			requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].byteLength;
			if (requestList[thisRequest].byteLengthWithFill % 2) { requestList[thisRequest].byteLengthWithFill += 1; };
			// Just for now...
			if (self.globalReadBlockList[i].parts > 1) {
				requestList[thisRequest].datatype = 'BYTE';
				requestList[thisRequest].dtypelen = 1;
				requestList[thisRequest].arrayLength = requestList[thisRequest].byteLength;//globalReadBlockList[thisBlock].byteLength;		
			}
			remainingLength -= maxByteRequest;
			startElement += maxByteRequest/requestList[thisRequest].multidtypelen;
			thisRequest++;
		}		
	}

	//requestList[5].offset = 243;	
	//	requestList = globalReadBlockList;
	
	// The packetizer...
	var requestNumber = 0;
	var itemsThisPacket;
	
	self.clearReadPacketTimeouts();
	self.readPacketArray = [];
	
//	outputLog("Request list length is " + requestList.length);
	
	while (requestNumber < requestList.length) {
		// Set up the read packet
		self.masterSequenceNumber += 1;
		if (self.masterSequenceNumber > 32767) {
			self.masterSequenceNumber = 1;
		}
		
		var numItems = 0;

		self.readPacketArray.push(new PLCPacket());
		var thisPacketNumber = self.readPacketArray.length - 1;
		self.readPacketArray[thisPacketNumber].seqNum = self.masterSequenceNumber;
//		outputLog("Sequence Number is " + self.readPacketArray[thisPacketNumber].seqNum);
	
		self.readPacketArray[thisPacketNumber].itemList = [];  // Initialize as array.  
	
		for (var i = requestNumber; i < requestList.length; i++) {
			if (numItems >= 1) {
				break;  // We can't fit this packet in here.  For now, this is always the case with PCCC.
			}
			requestNumber++;
			numItems++;
			self.readPacketArray[thisPacketNumber].itemList.push(requestList[i]);
		}
	}
	self.readPacketValid = true;
}

NodePCCC.prototype.sendReadPacket = function() {
	var self = this;
	var i, j, curLength, returnedBfr, routerLength;
	var flagReconnect = false;
	
	outputLog("SendReadPacket called",1,self.connectionID);
	
	for (i = 0;i < self.readPacketArray.length; i++) {
		if (self.readPacketArray[i].sent) { continue; }
		if (self.parallelJobsNow >= self.maxParallel) { continue; }
		// From here down is SENDING the packet
		self.readPacketArray[i].reqTime = process.hrtime();	

		curLength = 0;
		routerLength = 0;
		
		// We always need an EIP header with the CIP interface handle, etc.  
		self.EIP_CIP_Header.copy(self.readReq, curLength);
		curLength = self.EIP_CIP_Header.length;

		// This is the session handle that goes in the EIP header
		self.readReq.writeInt32LE(self.sessionHandle,4);

		// Sometimes we need the ask the message router to send the message for us.  That's what the routing header is for.
		if (self.Connection_Path.length > 0) {
			self.Routing_Header.copy(self.readReq, curLength);
			curLength += self.Routing_Header.length;
			routerLength = self.Routing_Header.length;
		}
			
		// We always need the PCCC encapsulation header (0x4b) which sends the final message to the PCCC object of the controller.  
		self.PCCC_Encapsulation_Header.copy(self.readReq, curLength);
		curLength += self.PCCC_Encapsulation_Header.length;

		// Write the sequence number to the offset in the PCCC encapsulation header.  Eventually this should be moved to within the FOR loop if we keep a FOR loop.  But with only one PCCC command per packet we don't care.
		self.readReq.writeUInt16LE(self.readPacketArray[i].seqNum, curLength - 2); // right at the end of the PCCC encapsulation header

		// The FOR loop is left in here for now, but really we are only doing one request per packet for now.  
		for (j = 0; j < self.readPacketArray[i].itemList.length; j++) {
			returnedBfr = SLCAddrToBufferA2(self.readPacketArray[i].itemList[j], false);

			outputLog('The A2 Returned Buffer is:',2);
			outputLog(returnedBfr, 2);
			outputLog("The returned buffer length is " + returnedBfr.length, 2);
			
			returnedBfr.copy(self.readReq, curLength);
			curLength += returnedBfr.length;
		}

		if (routerLength && ((returnedBfr.length + self.PCCC_Encapsulation_Header.length) % 2)) {
			self.readReq[curLength] = 0x00;  // Pad byte
			curLength += 1;
			routerLength += 1;  // Important as this counts towards the length written to the message
		}

		// Now we add the connection path length.
		if (routerLength > 0) {
			self.Connection_Path.copy(self.readReq, curLength);
			curLength += self.Connection_Path.length;
			routerLength += self.Connection_Path.length;
		}
		
		// This is the overall message length for the EIP header
		self.readReq.writeUInt16LE(curLength - 24, 2);
		
		outputLog("The PCCC Encapsulation Header is:", 2);
		outputLog(self.PCCC_Encapsulation_Header, 2);
		outputLog("The Returned buffer is:", 2);
		outputLog(returnedBfr, 2);
		
		// This is the overall message length for either the message sent to the message router OR the message sent to the controller directly if we aren't using a router.
		self.readReq.writeUInt16LE(returnedBfr.length + self.PCCC_Encapsulation_Header.length + routerLength, 38);
		
		if (routerLength > 0) {
			// This is the message length of the "message in a message" to notify the message router.
			self.readReq.writeUInt16LE(returnedBfr.length + self.PCCC_Encapsulation_Header.length, self.EIP_CIP_Header.length + self.Routing_Header.length - 2);
		}

		if (self.isoConnectionState == 4) {
			self.readPacketArray[i].timeout = setTimeout(function(){
				self.packetTimeout.apply(self,arguments);
			}, self.globalTimeout, "read", self.readPacketArray[i].seqNum); 
			self.isoclient.write(self.readReq.slice(0,curLength));  // was 31
			self.readPacketArray[i].sent = true;
			self.readPacketArray[i].rcvd = false;
			self.readPacketArray[i].timeoutError = false;
			self.parallelJobsNow += 1;
			outputLog('Sending Read Packet SEQ ' + self.readPacketArray[i].seqNum,1);	
		} else {
//			outputLog('Somehow got into read block without proper isoConnectionState of 4.  Disconnect.');
//			connectionReset();
//			setTimeout(connectNow, 2000, connectionParams);
// Note we aren't incrementing maxParallel so we are actually going to time out on all our packets all at once.    
			self.readPacketArray[i].sent = true;
			self.readPacketArray[i].rcvd = false;
			self.readPacketArray[i].timeoutError = true;	
			if (!flagReconnect) {
				// Prevent duplicates
				outputLog('Not Sending Read Packet because we are not connected - ISO CS is ' + self.isoConnectionState,0,self.connectionID);	
			}
			// This is essentially an instantTimeout.  
			if (self.isoConnectionState == 0) {
				flagReconnect = true;
			}
			outputLog('Requesting PacketTimeout Due to ISO CS NOT 4 - READ SN ' + self.readPacketArray[i].seqNum,1,self.connectionID);
			self.readPacketArray[i].timeout = setTimeout(function() {
				self.packetTimeout.apply(self, arguments);
			}, 0, "read", self.readPacketArray[i].seqNum); 
		}
	}

	if (flagReconnect) {
//		console.log("Asking for callback next tick and my ID is " + self.connectionID);
		setTimeout(function() {
//			console.log("Next tick is here and my ID is " + self.connectionID);
			outputLog("The scheduled reconnect from sendReadPacket is happening now",1,self.connectionID);	
			self.connectNow(self.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark isoConnectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
	
}

NodePCCC.prototype.sendWritePacket = function() {
	var self = this;
	var dataBuffer, itemDataBuffer, dataBufferPointer, curLength, returnedBfr, flagReconnect = false, routerLength;
	dataBuffer = new Buffer(8192);

	self.writeInQueue = false;
	
	for (i=0;i<self.writePacketArray.length;i++) {
		if (self.writePacketArray[i].sent) { continue; }
		if (self.parallelJobsNow >= self.maxParallel) { continue; }
		// From here down is SENDING the packet
		self.writePacketArray[i].reqTime = process.hrtime();	
		
		curLength = 0;
		routerLength = 0;
		
		self.EIP_CIP_Header.copy(self.writeReq, curLength);
		curLength = self.EIP_CIP_Header.length;

		// Sometimes we need the ask the message router to send the message for us.  That's what the routing header is for.
		if (self.Connection_Path.length > 0) {
			self.Routing_Header.copy(self.writeReq, curLength);
			curLength += self.Routing_Header.length;
			routerLength = self.Routing_Header.length;
		}
		
		self.PCCC_Encapsulation_Header.copy(self.writeReq, curLength);

		self.writeReq.writeUInt16LE(self.writePacketArray[i].seqNum, curLength + 15);
		curLength += self.PCCC_Encapsulation_Header.length;
		
		dataBufferPointer = 0;
		for (var j = 0; j < self.writePacketArray[i].itemList.length; j++) {
			returnedBfr = SLCAddrToBufferAA(self.writePacketArray[i].itemList[j]);

//			outputLog(returnedBfr);
			returnedBfr.copy(self.writeReq, curLength);
			curLength += returnedBfr.length;
		}
		outputLog("The returned buffer length is " + returnedBfr.length,1);
		
// see below		self.Connection_Path.copy(self.writeReq, curLength);
// see below		curLength += self.Connection_Path.length;
		
		if (routerLength && ((returnedBfr.length + self.PCCC_Encapsulation_Header.length) % 2)) {
			self.writeReq[curLength] = 0x00;  // Pad byte
			curLength += 1;
			routerLength += 1;  // Important as this counts towards the length written to the message
		}

		// Now we add the connection path length.
		if (routerLength > 0) {
			self.Connection_Path.copy(self.writeReq, curLength);
			curLength += self.Connection_Path.length;
			routerLength += self.Connection_Path.length;
		}
			
		self.writeReq.writeUInt16LE(curLength - 24, 2);
		self.writeReq.writeUInt16LE(returnedBfr.length + self.PCCC_Encapsulation_Header.length + routerLength, 38); 
		
		if (routerLength > 0) {
			// This is the message length of the "message in a message" to notify the message router.
			self.writeReq.writeUInt16LE(returnedBfr.length + self.PCCC_Encapsulation_Header.length, self.EIP_CIP_Header.length + self.Routing_Header.length - 2);
		}
		
		self.writeReq.writeInt32LE(self.sessionHandle,4);
		
		if (self.isoConnectionState === 4) {
			self.writePacketArray[i].timeout = setTimeout(function() {
				self.packetTimeout.apply(self, arguments);
			}, self.globalTimeout, "write", self.writePacketArray[i].seqNum); 
			self.isoclient.write(self.writeReq.slice(0,curLength));  // was 31
			self.writePacketArray[i].sent = true;
			self.writePacketArray[i].rcvd = false;
			self.writePacketArray[i].timeoutError = false;
			self.parallelJobsNow += 1;
			outputLog('Sending Write Packet With Sequence Number ' + self.writePacketArray[i].seqNum,1,self.connectionID);
		} else {
//			outputLog('Somehow got into write block without proper isoConnectionState of 4.  Disconnect.');
//			connectionReset();
//			setTimeout(connectNow, 2000, connectionParams);
			// This is essentially an instantTimeout.  
			self.writePacketArray[i].sent = true;
			self.writePacketArray[i].rcvd = false;
			self.writePacketArray[i].timeoutError = true;

			// Without the scopePlaceholder, this doesn't work.   writePacketArray[i] becomes undefined.
			// The reason is that the value i is part of a closure and when seen "nextTick" has the same value 
			// it would have just after the FOR loop is done.  
			// (The FOR statement will increment it to beyond the array, then exit after the condition fails)
			// scopePlaceholder works as the array is de-referenced NOW, not "nextTick".  
			var scopePlaceholder = self.writePacketArray[i].seqNum;
			process.nextTick(function() {
				self.packetTimeout("write", scopePlaceholder);
			});
			if (self.isoConnectionState == 0) {
				flagReconnect = true;
			}
		}
	}
	if (flagReconnect) {
//		console.log("Asking for callback next tick and my ID is " + self.connectionID);
		setTimeout(function() {
//			console.log("Next tick is here and my ID is " + self.connectionID);
			outputLog("The scheduled reconnect from sendWritePacket is happening now",1,self.connectionID);	
			self.connectNow(self.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark isoConnectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
}

NodePCCC.prototype.isOptimizableArea = function(area) {
	var self = this;
	// for PCCC always say yes.  
	if (self.doNotOptimize) { return false; } // Are we skipping all optimization due to user request?
	
	return true;
}

NodePCCC.prototype.onResponse = function(data) {
	var self = this;
	// Packet Validity Check.  Note that this will pass even with a "not available" response received from the server.
	// For length calculation and verification:
	// data[4] = COTP header length. Normally 2.  This doesn't include the length byte so add 1.
	// read(13) is parameter length.  Normally 4.
	// read(14) is data length.  (Includes item headers)
	// 12 is length of "S7 header"
	// Then we need to add 4 for TPKT header.  
	
	// Decrement our parallel jobs now

	// NOT SO FAST - can't do this here.  If we time out, then later get the reply, we can't decrement this twice.  Or the CPU will not like us.  Do it if not rcvd.  parallelJobsNow--;

	outputLog(data,2);  // Only log the entire buffer at high debug level 
	outputLog("onResponse called with length " + data.length,1);
	
	if (data.length < 24) { // not even long enough for EIP header
		outputLog('DATA LESS THAN 24 BYTES RECEIVED.  TOTAL CONNECTION RESET.');
		outputLog(data);
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}

	// The smallest read packet will pass a length check of 25.  For a 1-item write response with no data, length will be 22.  
	if (data.length > (data.readInt16LE(2) + 24)) {
		outputLog("An oversize packet was detected.  Excess length is " + (data.length - data.readInt16LE(2) - 24) + ".  ");
		outputLog("Usually because two packets were sent at nearly the same time by the PLC.");
		outputLog("We slice the buffer and schedule the second half for later processing.");
//		setTimeout(onResponse, 0, data.slice(data.readInt16LE(2) + 24));  // This re-triggers this same function with the sliced-up buffer.
		process.nextTick(function(){
			self.onResponse(data.slice(data.readInt16LE(2) + 24))
		});  // This re-triggers this same function with the sliced-up buffer.
// was used as a test		setTimeout(process.exit, 2000);
	}

	if (data.readInt32LE(4) !== self.sessionHandle) { // not even long enough for EIP header
		outputLog('INVALID SESSION HANDLE RECEIVED');
		outputLog('Expected ' + decimalToHexString(self.sessionHandle) + ' received ' + decimalToHexString(data.readInt32LE(4)));
		outputLog(data);
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}

	if (data.readInt32LE(8) !== 0) { // not even long enough for EIP header
		outputLog('EIP ERROR RECEIVED at zero-based offset 8/9/10/11');
		outputLog(data);
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}
	
	// First we check our error code.  
	if (data[8] !== 0x00 || data[9] !== 0x00 || data[10] !== 0x00 || data[11] !== 0x00) {
		outputLog('ERROR RECEIVED IN REGISTER SESSION RESPONSE PACKET - DISCONNECTING');
		outputLog(data);
		outputLog('Codes are ' + data[8] + " " + data[9] + " " + data[10] + " " + data[11]); 
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}

	// Do we check our context?  Let's not bother.
	
	// Expected length is from packet sniffing - some applications may be different
	if (data[0] !== 0x6f || data.readInt16LE(2) > (data.length - 24)) { 
		outputLog('INVALID PACKET or CONNECTION REFUSED - DISCONNECTING');
		outputLog(data);
		outputLog('RCV buffer length is ' + data.length + ' and data[0] is ' + data[0] + ' and DRI16LE2 is ' + data.readInt16LE(2)); 
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}

	outputLog('Valid EIP Data Response Received', 1);
	
	if (data.readInt32LE(24) !== 0 || data.readInt16LE(34) !== 0) { 
		outputLog('CIP ERROR RECEIVED at zero-based offset 8/9/10/11 or non-zero value at packet offset 34');
		outputLog(data);
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}

	if (data.readInt16LE(38) !== data.readInt16LE(2) - 16) {  // used to be data.length - 16 - 24 
		outputLog('Bad Length Statement of Unconnected Send Message at offset 38');
		outputLog('datalength is ' + data.length + ' and RI16LE2 is ' + data.readInt16LE(2));
		outputLog('data at 38 is ' + data.readInt16LE(38));
		outputLog(data);
		self.connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}

	if (data[40] !== 0xCB || data[41] !== 0x00 || data[42] !== 0x00 || data[43] !== 0x00) { 
		outputLog('Invalid response or response code in bytes 40-43.');
		outputLog('Service not supported maybe?  Bad path?');
		outputLog('This can occur on power-up reconnection or missing PLC-ENI link using ENI.');
		outputLog(data);
//		connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		// Returning null in this case will essentially force a timeout and retry.  
		// With an ENI this is "normal" in some power-up cases so we don't want to disconnect.
		return null;
	} 
	
	// Log the receive
	outputLog('Received ' + data.readUInt16LE(38) + ' bytes of CIP-data from PLC.', 1); 
	
	var PCCCData = data.slice(44, data.readUInt16LE(2) + 24);  // added length spec
	
	outputLog('Received ' + PCCCData.length + ' bytes of PCCC-data from PLC.', 1); 
	outputLog(PCCCData, 2);
	
	// Check the sequence number	
	var foundSeqNum = undefined; // readPacketArray.length - 1;
	var packetCount = undefined;
	var isReadResponse, isWriteResponse;
	
//	for (packetCount = 0; packetCount < readPacketArray.length; packetCount++) {
//		if (readPacketArray[packetCount].seqNum == data.readUInt16BE(11)) {
//			foundSeqNum = packetCount;
//			break;
//		}
//	}

	outputLog("On Response - Sequence " + PCCCData.readUInt16LE(9), 1);

	foundSeqNum = self.findReadIndexOfSeqNum(PCCCData.readUInt16LE(9));

//	if (readPacketArray[packetCount] == undefined) {
	if (foundSeqNum == undefined) {
		foundSeqNum = self.findWriteIndexOfSeqNum(PCCCData.readUInt16LE(9));
		if (foundSeqNum != undefined) {
//		for (packetCount = 0; packetCount < writePacketArray.length; packetCount++) {
//			if (writePacketArray[packetCount].seqNum == data.readUInt16BE(11)) {
//				foundSeqNum = packetCount; 
				self.writeResponse(PCCCData, foundSeqNum); 
				isWriteResponse = true;
//				break;
			}

		
	} else {
		isReadResponse = true;
		outputLog("Received Response to Sequence " + foundSeqNum,1);		
		self.readResponse(PCCCData, foundSeqNum);
	}
		
	if ((!isReadResponse) && (!isWriteResponse)) {
		outputLog("Sequence number that arrived wasn't a write reply either - dropping");
		outputLog(data);
// 	I guess this isn't a showstopper, just ignore it.  
//		connectionReset();
//		setTimeout(connectNow, 2000, connectionParams);
		return null;
	}
}

NodePCCC.prototype.findReadIndexOfSeqNum = function(seqNum) {
	var self = this;
	var packetCounter;
	for (packetCounter = 0; packetCounter < self.readPacketArray.length; packetCounter++) {
		if (self.readPacketArray[packetCounter].seqNum == seqNum) {
			return packetCounter; 
		}
	}
	return undefined;
}

NodePCCC.prototype.findWriteIndexOfSeqNum = function(seqNum) {
	var self = this;
	var packetCounter;
	for (packetCounter = 0; packetCounter < self.writePacketArray.length; packetCounter++) {
		if (self.writePacketArray[packetCounter].seqNum == seqNum) {
			return packetCounter; 
		}
	}
	return undefined;
}

NodePCCC.prototype.writeResponse = function(data, foundSeqNum) {
	var self = this;
	var dataPointer = 21,i,anyBadQualities;

	if (!self.writePacketArray[foundSeqNum].sent) {
		outputLog('WARNING: Received a write packet that was not marked as sent',0,self.connectionID);
		return null;
	}
	if (self.writePacketArray[foundSeqNum].rcvd) {
		outputLog('WARNING: Received a write packet that was already marked as received',0,self.connectionID);
		return null;
	}
	
	for (itemCount = 0; itemCount < self.writePacketArray[foundSeqNum].itemList.length; itemCount++) {
//		outputLog('Pointer is ' + dataPointer);
		dataPointer = processSLCWriteItem(data, self.writePacketArray[foundSeqNum].itemList[itemCount], dataPointer);
		if (!dataPointer) {
			outputLog('Stopping Processing Write Response Packet due to unrecoverable packet error');
			break;
		}
	}

	// Make a note of the time it took the PLC to process the request.  
	self.writePacketArray[foundSeqNum].reqTime = process.hrtime(self.writePacketArray[foundSeqNum].reqTime);
	outputLog('Time is ' + self.writePacketArray[foundSeqNum].reqTime[0] + ' seconds and ' + Math.round(self.writePacketArray[foundSeqNum].reqTime[1]*10/1e6)/10 + ' ms.',1);

//	writePacketArray.splice(foundSeqNum, 1);
	if (!self.writePacketArray[foundSeqNum].rcvd) {
		self.writePacketArray[foundSeqNum].rcvd = true;
		self.parallelJobsNow--;
	}
	clearTimeout(self.writePacketArray[foundSeqNum].timeout);	
	
	if (!self.writePacketArray.every(doneSending)) {
//			readPacketInterval = setTimeout(prepareReadPacket, 3000);
		self.sendWritePacket();
		outputLog("Sending again",1);
	} else {
		for (i=0;i<self.writePacketArray.length;i++) {
			self.writePacketArray[i].sent = false;
			self.writePacketArray[i].rcvd = false;				
		}
		
		anyBadQualities = false;
		
		for (i=0;i<self.globalWriteBlockList.length;i++) {
			// Post-process the write code and apply the quality.  
			// Loop through the global block list...
			writePostProcess(self.globalWriteBlockList[i]);
			outputLog(self.globalWriteBlockList[i].addr + ' write completed with quality ' + self.globalWriteBlockList[i].writeQuality,0);
			if (!isQualityOK(self.globalWriteBlockList[i].writeQuality)) { anyBadQualities = true; }
		}
		if (typeof(self.writeDoneCallback === 'function')) {
			self.writeDoneCallback(anyBadQualities);
		}
	}
}

NodePCCC.prototype.readResponse = function(data, foundSeqNum) {
	var self = this
		,anyBadQualities,dataPointer = 21  // For non-routed packets we start at byte 21 of the packet.  If we do routing it will be more than this.  
		,dataObject = {};

	outputLog("ReadResponse called",1,self.connectionID);

	if (!self.readPacketArray[foundSeqNum].sent) {
		outputLog('WARNING: Received a read response packet that was not marked as sent',0,self.connectionID);
		//TODO - fix the network unreachable error that made us do this		
		return null;
	}
	if (self.readPacketArray[foundSeqNum].rcvd) {
		outputLog('WARNING: Received a read response packet that was already marked as received',0,self.connectionID);
		return null;
	}
	
	for (itemCount = 0; itemCount < self.readPacketArray[foundSeqNum].itemList.length; itemCount++) {
		dataPointer = processSLCPacket(data, self.readPacketArray[foundSeqNum].itemList[itemCount], dataPointer);
		if (!dataPointer && typeof(data) !== "undefined") {
			// Don't bother showing this message on timeout.
			outputLog('Received a ZERO RESPONSE Processing Read Packet due to unrecoverable packet error');
//			break;  // We rely on this for our timeout now.  
		}
	}
	
	// Make a note of the time it took the PLC to process the request.  
	self.readPacketArray[foundSeqNum].reqTime = process.hrtime(self.readPacketArray[foundSeqNum].reqTime);
	outputLog('Read Time is ' + self.readPacketArray[foundSeqNum].reqTime[0] + ' seconds and ' + Math.round(self.readPacketArray[foundSeqNum].reqTime[1]*10/1e6)/10 + ' ms.',1,self.connectionID);

	// Do the bookkeeping for packet and timeout.  
	if (!self.readPacketArray[foundSeqNum].rcvd) {
		self.readPacketArray[foundSeqNum].rcvd = true;
		self.parallelJobsNow--;
		if (self.parallelJobsNow < 0) { self.parallelJobsNow = 0; }
	}
	clearTimeout(self.readPacketArray[foundSeqNum].timeout);	
	
	if(self.readPacketArray.every(doneSending)) {  // if sendReadPacket returns true we're all done.  
		// Mark our packets unread for next time.  
		outputLog('Every packet done sending',1,self.connectionID);
		for (i=0;i<self.readPacketArray.length;i++) {
			self.readPacketArray[i].sent = false;
			self.readPacketArray[i].rcvd = false;
		}
	
		anyBadQualities = false;
		
		// Loop through the global block list...
		for (var i=0;i<self.globalReadBlockList.length;i++) {
			var lengthOffset = 0;
			// For each block, we loop through all the requests.  Remember, for all but large arrays, there will only be one.  
			for (var j=0;j<self.globalReadBlockList[i].requestReference.length;j++) {
				// Now that our request is complete, we reassemble the BLOCK byte buffer as a copy of each and every request byte buffer.
				self.globalReadBlockList[i].requestReference[j].byteBuffer.copy(self.globalReadBlockList[i].byteBuffer,lengthOffset,0,self.globalReadBlockList[i].requestReference[j].byteLength);
				self.globalReadBlockList[i].requestReference[j].qualityBuffer.copy(self.globalReadBlockList[i].qualityBuffer,lengthOffset,0,self.globalReadBlockList[i].requestReference[j].byteLength);
				lengthOffset += self.globalReadBlockList[i].requestReference[j].byteLength;				
			}
			// For each ITEM reference pointed to by the block, we process the item. 
			for (var k=0;k<self.globalReadBlockList[i].itemReference.length;k++) {
//				outputLog(self.globalReadBlockList[i].itemReference[k].byteBuffer);
				processSLCReadItem(self.globalReadBlockList[i].itemReference[k]);
				outputLog('Address ' + self.globalReadBlockList[i].itemReference[k].addr + ' has value ' + self.globalReadBlockList[i].itemReference[k].value + ' and quality ' + self.globalReadBlockList[i].itemReference[k].quality,1,self.connectionID);
				if (!isQualityOK(self.globalReadBlockList[i].itemReference[k].quality)) { 
					anyBadQualities = true; 
					dataObject[self.globalReadBlockList[i].itemReference[k].useraddr] = self.globalReadBlockList[i].itemReference[k].quality;
				} else {
					dataObject[self.globalReadBlockList[i].itemReference[k].useraddr] = self.globalReadBlockList[i].itemReference[k].value;				
				}
			}
		}
		
		// Inform our user that we are done and that the values are ready for pickup.

		outputLog("We are calling back our readDoneCallback.",1,self.connectionID);
		if (typeof(self.readDoneCallback === 'function')) {
			self.readDoneCallback(anyBadQualities, dataObject, self.isoConnectionState !== 4);
		}
		if (self.resetPending) {
			self.resetNow();
		}
		if (!self.isReading() && self.writeInQueue) { self.sendWritePacket(); }
	} else {
		outputLog("Calling SRP from RR",1,self.connectionID);
		self.sendReadPacket();
	}
}

NodePCCC.prototype.onClientDisconnect = function() {
	var self = this;
	outputLog('EIP/TCP DISCONNECTED.');
	self.connectionCleanup();
	self.tryingToConnectNow = false;
}

NodePCCC.prototype.connectionReset = function() {
	var self = this;
	self.isoConnectionState = 0;
	self.resetPending = true;
	outputLog('ConnectionReset is happening');
	if (!self.isReading() && typeof(self.resetTimeout) === 'undefined') { // For now - ignore writes.  && !isWriting()) {	
		self.resetTimeout = setTimeout(function() {
			self.resetNow.apply(self, arguments);
		} ,1500);
	} 
	// For now we wait until read() is called again to re-connect.  
}

NodePCCC.prototype.resetNow = function() {
	var self = this;
	self.isoConnectionState = 0;
	self.isoclient.end();
	outputLog('ResetNOW is happening');
	self.resetPending = false;
	// In some cases, we can have a timeout scheduled for a reset, but we don't want to call it again in that case.
	// We only want to call a reset just as we are returning values.  Otherwise, we will get asked to read // more values and we will "break our promise" to always return something when asked. 
	if (typeof(self.resetTimeout) !== 'undefined') {
		clearTimeout(self.resetTimeout);
		self.resetTimeout = undefined;
		outputLog('Clearing an earlier scheduled reset');
	}
}

NodePCCC.prototype.connectionCleanup = function() {
	var self = this;
	self.isoConnectionState = 0;
	outputLog('Connection cleanup is happening');	
	if (typeof(self.isoclient) !== "undefined") {
		self.isoclient.removeAllListeners('data');
		self.isoclient.removeAllListeners('error');
		self.isoclient.removeAllListeners('connect');
		self.isoclient.removeAllListeners('end');
	}
	clearTimeout(self.connectTimeout);
	clearTimeout(self.PDUTimeout);
	self.clearReadPacketTimeouts();  // Note this clears timeouts.  
	self.clearWritePacketTimeouts();  // Note this clears timeouts.   
}

function outputLog(txt, debugLevel, id) {
	var idtext;
	if (typeof(id) === 'undefined') {
		idtext = '';
	} else {
		idtext = ' ' + id;
	}
	if (typeof(debugLevel) === 'undefined' || effectiveDebugLevel >= debugLevel) { console.log('[' + process.hrtime() + idtext + '] ' + util.format(txt)); }
}

function doneSending(element) {
	return ((element.sent && element.rcvd) ? true : false);
}

function processSLCPacket(theData, theItem, thePointer) {
	var remainingLength;
	
	if (typeof(theData) === "undefined") {
		remainingLength = 0;
//		outputLog("Processing an undefined packet, likely due to timeout error");
	} else {
		remainingLength = theData.length;
	}
	
	var prePointer = thePointer;

	// Create a new buffer for the quality.  
	theItem.qualityBuffer = new Buffer(theItem.byteLength);
	theItem.qualityBuffer.fill(0xFF);  // Fill with 0xFF (255) which means NO QUALITY in the OPC world.  
	
	if (remainingLength < 9) {
		theItem.valid = false;
		if (typeof(theData) !== "undefined") {
			theItem.errCode = 'Malformed PCCC Part - Less Than 9 Bytes.  TDL' + theData.length + 'TP' + thePointer + 'RL' + remainingLength;
			outputLog(theItem.errCode,0);  // Can't log more info here as we dont have "self" info
		} else {
			theItem.errCode = "Timeout error - zero length packet";
			outputLog(theItem.errCode,1);  // Can't log more info here as we dont have "self" info
		}
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.      
	}
	
	
	if (theData[0] !== 0x07 || theData[7] !== 0x4f) {
		theItem.valid = false;
		theItem.errCode = 'Invalid PCCC - Expected [0] to be 0x07 and [7] to be 0x4f - got ' + theData[0] + ' and ' + theData[7];
		outputLog(theItem.errCode);
		return 1; //thePointer + reportedDataLength + 4;
	}
	
	if (theData[8] !== 0x00) {
		theItem.valid = false;
		theItem.errCode = 'PCCC Error Response - Code ' + theData[8];
		outputLog(theItem.errCode);
		return 1; //thePointer + reportedDataLength + 4;   			      
	}	

	// There is no reported data length to check here - 
	// reportedDataLength = theData[9];

	expectedLength = theItem.byteLength;
			
	if (theData.length - 11 !== expectedLength) {
		theItem.valid = false;
		theItem.errCode = 'Invalid Response Length - Expected ' + expectedLength + ' but got ' + (theData.length - 11) + ' bytes.';
		outputLog(theItem.errCode);
		return 1;  
	}	

	// Looks good so far.  
	// Increment our data pointer past the status code, transport code and 2 byte length.
	thePointer += 4;
	
	var arrayIndex = 0;
	
	theItem.valid = true;
	theItem.byteBuffer = theData.slice(11); // This means take to end.
	
	outputLog('Byte Buffer is:',2);
	outputLog(theItem.byteBuffer,2);
	
	theItem.qualityBuffer.fill(0xC0);  // Fill with 0xC0 (192) which means GOOD QUALITY in the OPC world.  
	
	thePointer += theItem.byteLength; //WithFill;
	
	if (((thePointer - prePointer) % 2)) { // Odd number.  With the S7 protocol we only request an even number of bytes.  So there will be a filler byte.  
		thePointer += 1;
	}

//	outputLog("We have an item value of " + theItem.value + " for " + theItem.addr + " and pointer of " + thePointer);
	
	return -1; //thePointer;
}

function processSLCWriteItem(theData, theItem, thePointer) {
	
//	var remainingLength = theData.length - thePointer;  // Say if length is 39 and pointer is 35 we can access 35,36,37,38 = 4 bytes.  
//	var prePointer = thePointer;
	
	if (theData.length < 1 || theData.length < (theData[0] + 4) || theData[theData[0]] !== 0x4f) {  // Should be at least 11 bytes with 7 byte header
		theItem.valid = false;
		theItem.errCode = 'Malformed Reply PCCC Packet - Less Than 1 Byte or Malformed Header.  ' + theData;
		outputLog(theItem.errCode);
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.      
	}
	
	var writeResponse = theData.readUInt8(theData[0] + 1);
	
	theItem.writeResponse = theData.readUInt8(theData[0] + 1);
	
	if (writeResponse !== 0x00) {
		outputLog ('Received write error of ' + theItem.writeResponse + ' on ' + theItem.addr);
		theItem.writeQualityBuffer.fill(0xFF);  // Note that ff is good in the S7 world but BAD in our fill here.  
	} else {
		theItem.writeQualityBuffer.fill(0xC0);
	}	
	
	return -1;
}

function writePostProcess(theItem) {
	var thePointer = 0;
	if (theItem.arrayLength === 1) {
		if (theItem.writeQualityBuffer[0] === 0xFF) { 
			theItem.writeQuality = 'BAD';
		} else { 
			theItem.writeQuality = 'OK';
		}
	} else {
		// Array value.
		theItem.writeQuality = [];
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			if (theItem.writeQualityBuffer[thePointer] === 0xFF) { 
				theItem.writeQuality[arrayIndex] = 'BAD';
			} else { 
				theItem.writeQuality[arrayIndex] = 'OK';
			}
			if (theItem.datatype == 'X' ) {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  

				if ((((arrayIndex + theItem.bitOffset + 1) % 8) == 0) || (arrayIndex == theItem.arrayLength - 1)){
					thePointer += theItem.dtypelen;
					}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen;
			}
		}
	} 
}


function processSLCReadItem(theItem) {
	
	var thePointer = 0,strLength;
	
	if (theItem.arrayLength > 1) {
		// Array value.  
		if (theItem.datatype != 'C' && theItem.datatype != 'CHAR') {
			theItem.value = [];
			theItem.quality = [];
		} else {
			theItem.value = '';
			theItem.quality = '';
		}
		var bitShiftAmount = theItem.bitOffset;
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			if (theItem.qualityBuffer[thePointer] !== 0xC0) {
				theItem.value.push(theItem.badValue());
				theItem.quality.push('BAD ' + theItem.qualityBuffer[thePointer]);
			} else {
				// If we're a string, quality is not an array.
				if (theItem.quality instanceof Array) {
					theItem.quality.push('OK');
				} else {
					theItem.quality = 'OK';
				}
				switch(theItem.datatype) {

				case "REAL":
					theItem.value.push(theItem.byteBuffer.readFloatLE(thePointer));
					break;
				case "DWORD":
					theItem.value.push(theItem.byteBuffer.readUInt32LE(thePointer));
					break;
				case "DINT":
					theItem.value.push(theItem.byteBuffer.readInt32LE(thePointer));
					break;
				case "INT":
					theItem.value.push(theItem.byteBuffer.readInt16LE(thePointer));
					break;
				case "WORD":
					theItem.value.push(theItem.byteBuffer.readUInt16LE(thePointer));
					break;
				case "X":
					theItem.value.push(((theItem.byteBuffer.readUInt8(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
					break;
				case "B":
				case "BYTE":
					theItem.value.push(theItem.byteBuffer.readUInt8(thePointer));
					break;

				case "C":
				case "CHAR":
					// Convert to string.  
					theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
					break;
				case "TIMER":
				case "COUNTER":
				case "CONTROL":
					theItem.value.push(toABStructure(theItem.byteBuffer, thePointer, theItem.datatype));
					break;
				case "STRING":
					strLength = Math.min(theItem.byteBuffer.readUInt8(thePointer), 82);
					/** ALWAYS USE A BUFFER WITH A PAIR NUMBER OF BYTES */
					theItem.value.push(strSwap(theItem.byteBuffer.toString('ascii',2+thePointer,2+thePointer+strLength + (strLength % 2)),strLength));
					break;
				case "NSTRING":
					strLength = Math.min(theItem.byteBuffer.readUInt16LE(thePointer), 82);
					theItem.value.push(strSwap(theItem.byteBuffer.toString('ascii',4+thePointer,4+thePointer+strLength),strLength));
					break;
				default:
					outputLog("Unknown data type in response - should never happen.  Should have been caught earlier.  " + theItem.datatype);
					return 0;		
				}
			}
			if (theItem.datatype == 'X' ) {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  
				bitShiftAmount++;
				if ((((arrayIndex + theItem.bitOffset + 1) % 8) == 0) || (arrayIndex == theItem.arrayLength - 1)){
					thePointer += theItem.dtypelen;
					bitShiftAmount = 0;
					}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen; 	
			}
		}
	} else {		
		// Single value.  	
		if (theItem.qualityBuffer[thePointer] !== 0xC0) {
			theItem.value = theItem.badValue();
			theItem.quality = ('BAD ' + theItem.qualityBuffer[thePointer]);
		} else {
			theItem.quality = ('OK');
			outputLog("Item Datatype (single value) is " + theItem.datatype + " and BO is " + theItem.byteOffset, 1);			
			switch(theItem.datatype) {

			case "REAL":
				theItem.value = theItem.byteBuffer.readFloatLE(thePointer);
				break;
			case "DWORD":
				theItem.value = theItem.byteBuffer.readUInt32LE(thePointer);
				break;
			case "DINT":
				theItem.value = theItem.byteBuffer.readInt32LE(thePointer);
				break;
			case "INT":
				theItem.value = theItem.byteBuffer.readInt16LE(thePointer);
				break;
			case "WORD":
				theItem.value = theItem.byteBuffer.readUInt16LE(thePointer);
				break;
			case "X":
//			outputLog("Reading single Value ByteBufferLength is " + theItem.byteBuffer.length, 1);
				if (theItem.multidtypelen === 4) {
					theItem.value = (((theItem.byteBuffer.readUInt32LE(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
				} else {
					theItem.value = (((theItem.byteBuffer.readUInt16LE(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
				}
				break;
			case "B":
			case "BYTE":
				// No support as of yet for signed 8 bit.  This isn't that common in Siemens.  
				theItem.value = theItem.byteBuffer.readUInt8(thePointer);
				break;
			case "C":
			case "CHAR":
				// No support as of yet for signed 8 bit.  This isn't that common in Siemens.  
				theItem.value = String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
				break;
			case "STRING":
				strLength = Math.min(theItem.byteBuffer.readUInt8(thePointer), 82);
			        /** ALWAYS USE A BUFFER WITH A PAIR NUMBER OF BYTES */
				theItem.value = strSwap( theItem.byteBuffer.toString('ascii', 2 + thePointer, 2 + thePointer + strLength + (strLength % 2) ), strLength);
				break;
			case "NSTRING":
				strLength = Math.min(theItem.byteBuffer.readUInt16LE(thePointer), 82);
				theItem.value = strSwap( theItem.byteBuffer.toString('ascii', 4 + thePointer, 4 + thePointer + strLength + (strLength % 2) ), strLength);
				break;
			case "TIMER":
			case "COUNTER":
			case "CONTROL":
				if (theItem.byteOffset >= 0) {
					theItem.value = theItem.byteBuffer.readInt16LE(thePointer + theItem.byteOffset);
				} else {
					theItem.value = toABStructure(theItem.byteBuffer, thePointer, theItem.datatype);
				}
				break;			
			default:
				outputLog("Unknown data type in response - should never happen.  Should have been caught earlier.  " + theItem.datatype);
				return 0;		
			}
		}
		thePointer += theItem.dtypelen; 	
	}	

	if (((thePointer) % 2)) { // Odd number.  With the S7 protocol we only request an even number of bytes.  So there will be a filler byte.  
		thePointer += 1;
	}

//	outputLog("We have an item value of " + theItem.value + " for " + theItem.addr + " and pointer of " + thePointer);	
	return thePointer; // Should maybe return a value now???
}

function strSwap(str, origLength) {
	var newStr = '', i = 0;
	if (str && str.constructor == String) {
		while ( i < str.length) {
			if (i < str.length - 2) {
				newStr = newStr.concat(str.substr( i + 1, 1), str.substr( i, 1));
			}else{
				/** THE LAST 2 CHARACTERS */
				newStr = newStr.concat(str.substr( i + 1, 1 ));
				if (str.substr( i, 1) != "\u0000" && !(origLength % 2)) newStr = newStr.concat(str.substr( i, 1)); // Skip for odd length strings
			}
			i = i + 2;
		}
		return newStr;
	}
	return str;
}

function bufferizePCCCItem(theItem) {	
	var thePointer, theByte, strLength;
	theByte = 0;
	thePointer = 0; // After length and header
	
	if (theItem.arrayLength > 1) {
		// Array value.  
		var bitShiftAmount = theItem.bitOffset;
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			switch(theItem.datatype) {
				case "REAL":
					theItem.writeBuffer.writeFloatLE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "DWORD":
					theItem.writeBuffer.writeInt32LE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "DINT":
					theItem.writeBuffer.writeInt32LE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "INT":
					theItem.writeBuffer.writeInt16LE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "WORD":
					theItem.writeBuffer.writeUInt16LE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "X":
					theByte = theByte | (((theItem.writeValue[arrayIndex] === true) ? 1 : 0) << bitShiftAmount);		
					// Maybe not so efficient to do this every time when we only need to do it every 8.  Need to be careful with optimizations here for odd requests.  
					theItem.writeBuffer.writeUInt8(theByte, thePointer);
					bitShiftAmount++;
					break;
				case "B":
				case "BYTE":
					theItem.writeBuffer.writeUInt8(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "C":
				case "CHAR":
					// Convert to string.  
//??					theItem.writeBuffer.writeUInt8(theItem.writeValue.toCharCode(), thePointer);
					theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer);
					break;
				case "TIMER":
				case "COUNTER":
				case "CONTROL":
					// We don't support writing arrays of timers and counters.  Read array but write individual.
					//theItem.writeBuffer.writeInt16LE(theItem.writeValue[arrayIndex], thePointer);
					//break;
					outputLog("Please don't write arrays of timers or counters or control.  Write individual words/bits.");
					return 0;
				case "STRING":
					strLength = Math.min(theItem.writeValue[arrayIndex].length,82);
					theItem.writeBuffer.writeUInt8(strLength,thePointer);
					theItem.writeBuffer.writeUInt8(0,thePointer+1);
					theItem.writeBuffer.write(strSwap(theItem.writeValue[arrayIndex]),thePointer+2,(strLength % 2) ? strLength + 1 : strLength,'ascii');
					break;
				default:
					outputLog("Unknown data type when preparing array write packet - should never happen.  Should have been caught earlier.  " + theItem.datatype);
					return 0;		
			}
			if (theItem.datatype == 'X' ) {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  

				if ((((arrayIndex + theItem.bitOffset + 1) % 8) == 0) || (arrayIndex == theItem.arrayLength - 1)){
					thePointer += theItem.dtypelen;
					bitShiftAmount = 0;
					}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen;
			}
		}
	} else {
		// Single value. 
		switch(theItem.datatype) {

			case "REAL":
				theItem.writeBuffer.writeFloatLE(theItem.writeValue, thePointer);
				break;
			case "DWORD":
				theItem.writeBuffer.writeUInt32LE(theItem.writeValue, thePointer);
				break;
			case "DINT":
				theItem.writeBuffer.writeInt32LE(theItem.writeValue, thePointer);
				break;
			case "INT":
				theItem.writeBuffer.writeInt16LE(theItem.writeValue, thePointer);
				break;
			case "WORD":
				theItem.writeBuffer.writeUInt16LE(theItem.writeValue, thePointer);
				break;
			case "X":
				theItem.writeBuffer.writeUInt8(((theItem.writeValue) ? 1 : 0), thePointer);  // checked ===true but this caused problems if you write 1
				outputLog("Datatype is X writing " + theItem.writeValue + " tpi " + theItem.writeBuffer[0],1);
				
// not here				theItem.writeBuffer[1] = 1; // Set transport code to "BIT" to write a single bit. 
// not here				theItem.writeBuffer.writeUInt16BE(1, 2); // Write only one bit.  				
				break;
			case "B":
			case "BYTE":
				// No support as of yet for signed 8 bit.  This isn't that common in Siemens.  
				theItem.writeBuffer.writeUInt8(theItem.writeValue, thePointer);
				break;
			case "C":
			case "CHAR":
				// No support as of yet for signed 8 bit.  This isn't that common in Siemens.  
				theItem.writeBuffer.writeUInt8(String.toCharCode(theItem.writeValue), thePointer);
				break;
			case "TIMER":
			case "COUNTER":
			case "CONTROL":
				theItem.writeBuffer.writeInt16LE(theItem.writeValue, thePointer);
				break;
			case "STRING":
				strLength = Math.min(theItem.writeValue.length,82);
				theItem.writeBuffer.writeUInt8(strLength,thePointer);
				theItem.writeBuffer.writeUInt8(0,thePointer+1);
				theItem.writeBuffer.write(strSwap(theItem.writeValue),thePointer+2,(strLength % 2) ? strLength + 1 : strLength,'ascii');
				break;
			default:
				outputLog("Unknown data type in write prepare - should never happen.  Should have been caught earlier.  " + theItem.datatype);
				return 0;		
		}
		thePointer += theItem.dtypelen; 	
	}	
	return undefined; 
}

function isQualityOK(obj) {
	if (typeof obj === "string") { 
		if (obj !== 'OK') { return false; } 
	} else if (_.isArray(obj)) {
		for (i = 0; i < obj.length; i++) {
			if (typeof obj[i] !== "string" || obj[i] !== 'OK') { return false; }
		}
	}
	return true;
}

function SLCAddrToBufferA2(addrinfo, isWriting) {
	// OK - this buffer is for message type 91, that works for the ENI but for nothing else.  .  var thisBitOffset = 0, theReq = new Buffer([0x91,0x00,0x09,0x00,0x0f,0x00,0x1e,0x07,0xa2,0x02,0x07,0x89,0x00]);  // Example used a1 instead of a2.  But a1 is not a documented DF1 command.  A2 is.  See DF1 manual.
	var thisBitOffset = 0;
	var extraOffset = 0;
	var subelement = 0;
	
	var PCCCCommand = new Buffer(12);  // 12 is max length with all fields at max.  
	
	extraOffset = 0;
	
	PCCCCommand[0] = 0xa2;  // A2 = protected typed logical read with 3 address fields.  See (google) the AB DF1 manual.  	
	PCCCCommand[1] = addrinfo.byteLength;  // On ethernet this is max 225 bytes.  Don't request more than this.  

	if (addrinfo.fileNumber <= 254) {
		PCCCCommand[2] = addrinfo.fileNumber;
		extraOffset = 0;
	} else {
		PCCCCommand[2] = 0xff;
		PCCCCommand.writeUInt16LE(addrinfo.fileNumber, 3);
		extraOffset = 2;	
	}
	
	PCCCCommand[3+extraOffset] = addrinfo.areaPCCCCode;  // File type

	if (addrinfo.offset <= 254) {
		PCCCCommand[4+extraOffset] = addrinfo.offset;
	} else {
		PCCCCommand[4+extraOffset] = 0xff;
		PCCCCommand.writeUInt16LE(addrinfo.fileNumber, 5+extraOffset);
		extraOffset = extraOffset + 2;
	}

	if (isWriting) {
		subelement = addrinfo.subelement;
	} else {
		subelement = 0;
	}
	
	// We used to directly use bitoffset here.
	if (subelement <= 254) {
		PCCCCommand[5+extraOffset] = subelement;
	} else {
		PCCCCommand[5+extraOffset] = 0xff;
		PCCCCommand.writeUInt16LE(subelement, 6+extraOffset);
		extraOffset = extraOffset + 2;
	}
	
	return PCCCCommand.slice(0,6+extraOffset);
}

function SLCAddrToBufferAA(addrinfo) {
	// OK - this buffer is for message type 91, that works for the ENI but for nothing else.  .  var thisBitOffset = 0, theReq = new Buffer([0x91,0x00,0x09,0x00,0x0f,0x00,0x1e,0x07,0xa2,0x02,0x07,0x89,0x00]);  // Example used a1 instead of a2.  But a1 is not a documented DF1 command.  A2 is.  See DF1 manual.
	var thisBitOffset = 0;
	var extraOffset = 0;
	var subelement = 0;
	var isWriting = true;
	var isBit = false;
	var writeLength = 0;
	
	var PCCCCommand = new Buffer(300);  // 300 should always cover us. 
	
	extraOffset = 0;
	
	PCCCCommand[0] = 0xaa;  // AA = protected typed logical write with 3 address fields.  See (google) the AB DF1 manual.  	
	
	isBit = (addrinfo.datatype === "X" && addrinfo.arrayLength <= 1) ? true : false;

	if(isBit) {
		return SLCAddrToBufferAB(addrinfo);
	}

	writeLength = isBit ? 1 : addrinfo.writeByteLength;
	
	PCCCCommand[1] = writeLength;  // On ethernet this is max 225 bytes.  Don't request more than this.  

	if (addrinfo.fileNumber <= 254) {
		PCCCCommand[2] = addrinfo.fileNumber;
		extraOffset = 0;
	} else {
		PCCCCommand[2] = 0xff;
		PCCCCommand.writeUInt16LE(addrinfo.fileNumber, 3);
		extraOffset = 2;	
	}
	
	PCCCCommand[3+extraOffset] = addrinfo.areaPCCCCode; //isBit ? 0x85 : addrinfo.areaPCCCCode;  // File type

	if (addrinfo.offset <= 254) {
		PCCCCommand[4+extraOffset] = addrinfo.offset;
	} else {
		PCCCCommand[4+extraOffset] = 0xff;
		PCCCCommand.writeUInt16LE(addrinfo.fileNumber, 5+extraOffset);
		extraOffset = extraOffset + 2;
	}

	if (isWriting) {
		subelement = addrinfo.subelement;
	} else {
		subelement = 0;
	}
	
	// We used to directly use bitoffset here.
	if (subelement <= 254) {
		PCCCCommand[5+extraOffset] = subelement;
	} else {
		PCCCCommand[5+extraOffset] = 0xff;
		PCCCCommand.writeUInt16LE(subelement, 6+extraOffset);
		extraOffset = extraOffset + 2;
	}
	
	addrinfo.writeBuffer.copy(PCCCCommand,6+extraOffset,0,writeLength);

	outputLog("AddrInfo WriteBuffer[0] is " + addrinfo.writeBuffer[0],2);
	
	return PCCCCommand.slice(0,6+extraOffset+writeLength);
}

function SLCAddrToBufferAB(addrinfo) {   // AB is the SLC version of read-modify-write.  USE AT YOUR OWN RISK as this is not documented in the DF1 manual.  
	// OK - this buffer is for message type 91, that works for the ENI but for nothing else.  .  var thisBitOffset = 0, theReq = new Buffer([0x91,0x00,0x09,0x00,0x0f,0x00,0x1e,0x07,0xa2,0x02,0x07,0x89,0x00]);  // Example used a1 instead of a2.  But a1 is not a documented DF1 command.  A2 is.  See DF1 manual.
	var thisBitOffset = 0;
	var extraOffset = 0;
	var subelement = 0;
	var isWriting = true;
	var isBit = false;
	var writeLength = 0;
	var andMask = 0;
	var orMask = 0;
	
	var PCCCCommand = new Buffer(300);  // 300 should always cover us. 
	
	extraOffset = 0;
	
	PCCCCommand[0] = 0xab;  // AA = protected typed logical read-modify-write with 3 address fields.  See (google) the AB DF1 manual, look at 0xAA, then look at the PLC-5 read-modify-write.  	And tell AB they should document their stuff better.
	
	isBit = (addrinfo.datatype === "X" && addrinfo.arrayLength <= 1) ? true : false;
	
	if (!isBit) {
		outputLog("You're not supposed to Read-Modify-Write a non-bit.  So don't.");
		return undefined;
	}	

	if (addrinfo.subelement > 15) {
		outputLog("We can't find any documentation detailing how to set bits > 15 on MicroLogix or ControlLogix");
		outputLog("So we are not going to try to write this - returning undefined.");
		outputLog("OPC servers seem to read, then write the WHOLE DINT which we don't want to do.");
		return undefined;
	}	
	
	// After some trial-and-error it seems this 0xAB function doesn't work with long integer types.
	// So we need to possibly investigate the 0xA
	//writeLength = addrinfo.multidtypelen;  // We are forced to do a two-byte mask at all times.  At least with CompactLogix this is all the PLC will accept.  
	writeLength = 2;
	
	PCCCCommand[1] = writeLength;  // On ethernet this is max 225 bytes.  Don't request more than this.  

	if (addrinfo.fileNumber <= 254) {
		PCCCCommand[2] = addrinfo.fileNumber;
		extraOffset = 0;
	} else {
		PCCCCommand[2] = 0xff;
		PCCCCommand.writeUInt16LE(addrinfo.fileNumber, 3);
		extraOffset = 2;	
	}
	
	PCCCCommand[3+extraOffset] = addrinfo.areaPCCCCode; 	// File type

	if (addrinfo.offset <= 254) {
		PCCCCommand[4+extraOffset] = addrinfo.offset;
	} else {
		PCCCCommand[4+extraOffset] = 0xff;
		PCCCCommand.writeUInt16LE(addrinfo.fileNumber, 5+extraOffset);
		extraOffset = extraOffset + 2;
	}

	// We should always be writing.
	andMask = 1 << addrinfo.subelement;
	
	// We used to directly use bitoffset here.
//	if (subelement <= 254) {
	PCCCCommand[5+extraOffset] = 0;  // We don't currently plan on using RMW for anything but bits.
//	} else {
//		PCCCCommand[5+extraOffset] = 0xff;
//		PCCCCommand.writeUInt16LE(subelement, 6+extraOffset);
//		extraOffset = extraOffset + 2;
	//}
	
	if (addrinfo.writeBuffer[0] > 0) {
		orMask = andMask;
	} else {
		orMask = 0;
	}

// tried but not supported by PLC	if (writeLength === 4) {
// tried but not supported by PLC		// Only for CompactLogix/MicroLogix writing bits in L-words
// tried but not supported by PLC		console.log("AND mask: " + andMask);
// tried but not supported by PLC		console.log("OR mask: " + orMask);
// tried but not supported by PLC		console.log("AISE: " + addrinfo.subelement);
// tried but not supported by PLC		// Since NodeJS also uses long integers, we can't use unsigned here.
// tried but not supported by PLC		PCCCCommand.writeInt32LE(andMask, 6+extraOffset);
// tried but not supported by PLC		PCCCCommand.writeInt32LE(orMask, 6+writeLength+extraOffset);
// tried but not supported by PLC	} else {
	PCCCCommand.writeUInt16LE(andMask, 6+extraOffset);
	PCCCCommand.writeUInt16LE(orMask, 8+extraOffset);
	
	return PCCCCommand.slice(0,6+extraOffset+4);  // If varying write length is possible this will have to change
// tried but not supported by PLC	return PCCCCommand.slice(0,6+extraOffset+(writeLength*2));  // Used to add 4 here instead of writeLength*2
}


function stringToSLCAddr(addr, useraddr) {
	"use strict";
	var theItem, splitString, splitString2, prefix, postDotAlpha, postDotNumeric, forceBitDtype;
	theItem = new PLCItem();
	splitString = addr.split(':');
	if (splitString.length !== 2) {
		splitString = addr.split('/');
		if (splitString.length !== 2) {
			if (useraddr !== '_COMMERR') {
				outputLog("Error - String Couldn't Split Properly.  For SLC Addressing it needs a : to be valid.");
			}
			return undefined;
		} else {
			splitString[1] = '0/' + splitString[1];
			outputLog("An address was specified without an element number - assuming 0.",1);
			outputLog("SplitString[1] in this case is " + splitString[1],1);
		}
	}

	// Get the file number from the first part.  Note that for O, I, S types this might not exist.  
	theItem.fileNumber = parseInt(splitString[0].replace(/[A-z]/gi, ''), 10);

	splitString2 = splitString[1].split(',');  
	if (splitString2.length == 2) {
		theItem.arrayLength = parseInt(splitString2[1].replace(/[A-z]/gi, ''), 10);
	} else {
		theItem.arrayLength = 1;
	}
	splitString2[0] = splitString2[0].replace("/",".");
	var splitdot = splitString2[0].split('.');
	if (splitdot.length > 2) {
		outputLog("Error - String Couldn't Split Properly.  For SLC Addressing you can have only one dot OR slash.");
		return undefined;
	}
	if (splitdot.length == 2)
	{
		postDotNumeric = parseInt(splitdot[1].replace(/[A-z]/gi, ''), 10);
//		outputLog('PostDotNumeric is ' + postDotNumeric);
		postDotAlpha = splitdot[1].replace(/[0-9]/gi, '').toUpperCase();
		if (postDotNumeric.length > 0 && postDotAlpha && postDotAlpha.length > 0) {
			outputLog("Error - String Couldn't Split Properly.  For SLC Addressing you can have only one subelement specifier.");
			return undefined;
		}
	}

	theItem.offset = parseInt(splitdot[0].replace(/[A-z]/gi, ''), 10);

	if (postDotAlpha && postDotAlpha.length > 0 && theItem.arrayLength > 1) {
		outputLog("Error - You can't have an array of alpha sub-elements like timer presets, etc.");
		return undefined;
	}

	forceBitDtype = false;
	theItem.subelement = 0;
	
	if (typeof(postDotNumeric) !== "undefined" && postDotNumeric >= 0) {
		theItem.bitOffset = postDotNumeric;
		theItem.subelement = postDotNumeric; // for now we do this too.  
		forceBitDtype = true;
		outputLog("PostDotNumeric is " + postDotNumeric,1);
	} else {
		theItem.bitOffset = 0;
	}

	theItem.dtypelen = -1;
	theItem.byteOffset = -1;
		
	if (postDotAlpha && postDotAlpha.length > 0) {
		switch(postDotAlpha) {
		case "PRE":		// T,C type
		case "LEN":		// R type
			theItem.subelement = 1;
			theItem.bitOffset = 1;
			theItem.byteOffset = 2;
			break;
		case "ACC":		// T,C type
		case "POS":		// R type
			theItem.subelement = 2;
			theItem.bitOffset = 2;
			theItem.byteOffset = 4;
			break;
		case "EN":		// T,R type
		case "CU":		// C type
			theItem.subelement = 0;
			theItem.bitOffset = 15;
			forceBitDtype = true;
			break;
		case "TT":		// T type
		case "EU":		// R type
		case "CD":		// C type
			theItem.subelement = 0;
			theItem.bitOffset = 14;
			forceBitDtype = true;
			break;
		case "DN":		// C,R,T type
			theItem.subelement = 0;
			theItem.bitOffset = 13;
			forceBitDtype = true;
			break;
		case "OV":		// C type
		case "EM":		// R type
			theItem.subelement = 0;
			theItem.bitOffset = 12;
			forceBitDtype = true;
			break;
		case "UN":		// C type
		case "ER":		// R type
			theItem.subelement = 0;
			theItem.bitOffset = 11;
			forceBitDtype = true;
			break;
		case "UL":		// R type
			theItem.subelement = 0;
			theItem.bitOffset = 10;
			forceBitDtype = true;
			break;
		case "IN":		// R type
			theItem.subelement = 0;
			theItem.bitOffset = 10;
			forceBitDtype = true;
			break;
		case "FD":		// R type
			theItem.subelement = 0;
			theItem.bitOffset = 10;
			forceBitDtype = true;
			break;
		default:
			outputLog("Error - String Couldn't Split Properly.  Couldn't understand your subelement specifier.");
			outputLog("It was " + postDotAlpha);
			return undefined;
		}
	}
		
	// Get the data type from the second part.  
	prefix = splitString[0].replace(/[0-9]/gi, '');
	switch (prefix) {
	case "S":
	case "I":
	case "N":
	case "O":
	case "B":
		theItem.addrtype = prefix;
		theItem.datatype = "INT";
		theItem.multidtypelen = 2;
		break;
	case "L": // Micrologix Only
		theItem.addrtype = prefix;
		theItem.datatype = "DINT";
		theItem.multidtypelen = 4;
		break;
	case "F":
		theItem.addrtype = prefix;
		theItem.datatype = "REAL";
		theItem.multidtypelen = 4;
		break;
	case "T":
		theItem.addrtype = prefix;
		theItem.datatype = "TIMER";
		theItem.multidtypelen = 6;
		break;
	case "C":
		theItem.addrtype = prefix;
		theItem.datatype = "COUNTER";
		theItem.multidtypelen = 6;
		break;
	case "ST":
		theItem.addrtype = prefix;
		theItem.datatype = "STRING";
		theItem.multidtypelen = 84;
		break;
	case "NST": // N as string - special type to read strings moved into an integer array to support CompactLogix read-only.
		theItem.addrtype = prefix;
		theItem.datatype = "NSTRING";
		theItem.multidtypelen = 42;
		break;
	case "R":
		theItem.addrtype = prefix;
		theItem.datatype = "CONTROL";
		theItem.multidtypelen = 6;
		break;
	case "A":	// TODO - support this.
	default:
		outputLog('Failed to find a match for ' + splitString2[0] + ' possibly because ' + prefix + ' type is not supported yet.');
		return undefined;
	}

	if (theItem.multidtypelen && theItem.bitOffset >= theItem.multidtypelen*8) {
		var remainder = theItem.bitOffset % (theItem.multidtypelen*8);
		var original = (theItem.bitOffset - remainder)/(theItem.multidtypelen*8);
		
		theItem.offset += original;
		theItem.bitOffset = remainder; 
	}
	
	if (isNaN(theItem.fileNumber)) {
		switch (prefix) {
		case "S":
			theItem.fileNumber = 2;
			break;
		case "I":
			theItem.fileNumber = 1;
			break;
		case "O":
			theItem.fileNumber = 0;
			break;
		default:
			outputLog("Error - Except for S,I,O you must specify a file number.");
			return undefined;
		}
	}	
		
	switch (theItem.addrtype) {
	case "S":
		theItem.areaPCCCCode = 0x84;
		theItem.dtypelen = 2;
		theItem.datatype = "INT";		
		break;
	case "B":
		theItem.areaPCCCCode = 0x85;
		theItem.dtypelen = 2;
		break;
	case "T":
		theItem.areaPCCCCode = 0x86;
		theItem.dtypelen = 6;
		theItem.writeDtypelen = 2;
		break;
	case "C":
		theItem.areaPCCCCode = 0x87;
		theItem.dtypelen = 6;
		theItem.writeDtypelen = 2;
		break;
	case "R":
		theItem.areaPCCCCode = 0x88;
		theItem.dtypelen = 6;
		theItem.writeDtypelen = 2;
		break;
	case "N":
		theItem.areaPCCCCode = 0x89;
		theItem.dtypelen = 2;
		break;
	case "F":
		theItem.areaPCCCCode = 0x8a;
		theItem.dtypelen = 4;			
		break;
	case "L": // MicroLogix only
		theItem.areaPCCCCode = 0x91;
		theItem.dtypelen = 4;
		break;
	case "O":
		theItem.areaPCCCCode = 0x8b;
		theItem.dtypelen = 2;			// Might have to vary this based on subelement.
		break;
	case "I":
		theItem.areaPCCCCode = 0x8c;
		theItem.dtypelen = 2;			// Might have to vary this based on subelement.
		break;		
	case "ST":
		theItem.areaPCCCCode = 0x8d;
		theItem.dtypelen = 84;			// 42 words is 84 bytes including the length byte
		break;
	case "NST": // N as string - special type to read strings moved into an integer array to support CompactLogix read-only.
		theItem.areaPCCCCode = 0x89;
		theItem.dtypelen = 42;			// 42 words is 84 bytes including the length byte
		break;
	case "A":
		theItem.areaPCCCCode = 0x8e;
		theItem.dtypelen = 1;			// Might have to vary this based on subelement.
		break;
	case "BCD": // not supported
		theItem.areaPCCCCode = 0x8f;
		theItem.dtypelen = 2;			// A guess.  Not really supported.
		break;
	default:
		outputLog("Unknown memory area entered - " + theItem.addrtype);
		return undefined;
	}

	if (forceBitDtype) {
		theItem.datatype = "X";
	}
	
	// Save the address from the argument for later use and reference
	theItem.addr = addr;
	if (useraddr === undefined) {
		theItem.useraddr = addr;
	} else {
		theItem.useraddr = useraddr;	
	}

	if (theItem.datatype === 'X') {
		theItem.byteLength = Math.ceil((theItem.bitOffset + theItem.arrayLength) / 8);
		theItem.writeByteLength = theItem.byteLength;
		if (theItem.byteLength % 2) { theItem.byteLength += 1; }  // Always even for AB
	} else {
		theItem.byteLength = theItem.arrayLength * theItem.dtypelen;
		if (typeof(theItem.writeDtypelen) !== 'undefined') {
			// The write length is different for timers, counters and controls where we read 6 elements always (to support arrays) but write the subelement.
			theItem.writeByteLength = theItem.arrayLength * theItem.writeDtypelen;
		} else {
			theItem.writeByteLength = theItem.byteLength;
		}
	}

//	outputLog(' Arr lenght is ' + theItem.arrayLength + ' and DTL is ' + theItem.dtypelen);
//	outputLog(' PCCC Code is ' + decimalToHexString(theItem.areaPCCCCode) + ' and addrtype is ' + theItem.addrtype);
//	outputLog(' Offset is ' + decimalToHexString(theItem.offset) + ' and bit offset is ' + theItem.bitOffset);
//	outputLog(' File Number is ' + theItem.fileNumber);
	
	theItem.byteLengthWithFill = theItem.byteLength;
	if (theItem.byteLengthWithFill % 2) { theItem.byteLengthWithFill += 1; }  // S7 will add a filler byte.  Use this expected reply length for PDU calculations.  

	return theItem;
}

function outputError(txt) {
	util.error(txt);
}

function decimalToHexString(number)
{
    if (number < 0)
    {
    	number = 0xFFFFFFFF + number + 1;
    }

    return "0x" + number.toString(16).toUpperCase();
}

function PLCPacket() {
	this.seqNum = undefined;				// Made-up sequence number to watch for.  
	this.itemList = undefined;  			// This will be assigned the object that details what was in the request.  
	this.reqTime = undefined;
	this.sent = false;						// Have we sent the packet yet?
	this.rcvd = false;						// Are we waiting on a reply?
	this.timeoutError = undefined;			// The packet is marked with error on timeout so we don't then later switch to good data. 
	this.timeout = undefined;				// The timeout for use with clearTimeout()
}

function PLCItem() { // Object
	// EIP only
	this.areaPCCCCode = undefined;

	// Save the original address
	this.addr = undefined;
	this.useraddr = undefined;

	// First group is properties to do with S7 - these alone define the address.
	this.addrtype = undefined;
	this.datatype = undefined;
	this.dbNumber = undefined;
	this.bitOffset = undefined;
	this.byteOffset = undefined;
	this.offset = undefined;	
	this.arrayLength = undefined;

	// These next properties can be calculated from the above properties, and may be converted to functions.
	this.dtypelen = undefined;
	this.writeDtypelen = undefined;
	this.multidtypelen = undefined; // multi-datatype length.  Different than dtypelen when requesting a timer preset, for example, which has width two but dtypelen of 2.
	this.areaS7Code = undefined;
	this.byteLength = undefined;
	this.writeByteLength = undefined;
	this.byteLengthWithFill = undefined;
	
	// Note that read transport codes and write transport codes will be the same except for bits which are read as bytes but written as bits
	this.readTransportCode = undefined;
	this.writeTransportCode = undefined;

	// This is where the data can go that arrives in the packet, before calculating the value.  
	this.byteBuffer = new Buffer(8192);
	this.writeBuffer = new Buffer(8192);
	
	// We use the "quality buffer" to keep track of whether or not the requests were successful.  
	// Otherwise, it is too easy to lose track of arrays that may only be partially complete.  
	this.qualityBuffer = new Buffer(8192);
	this.writeQualityBuffer = new Buffer(8192);
	
	// Then we have item properties
	this.value = undefined;
	this.writeValue = undefined;
	this.valid = false;
	this.errCode = undefined;
	
	// Then we have result properties
	this.part = undefined;
	this.maxPart = undefined;
	
	// Block properties
	this.isOptimized = false;
	this.resultReference = undefined;
	this.itemReference = undefined;
	
	// And functions...
	this.clone = function() {
		var newObj = new PLCItem();
		for (var i in this) {
			if (i == 'clone') continue;
			newObj[i] = this[i];
		} return newObj;
	};

	// Bad value function definition
	this.badValue = function() {
		switch (this.datatype){
		case "REAL":
			return 0.0;
		case "DWORD":
		case "DINT":
		case "INT":
		case "WORD":
		case "B":
		case "BYTE":
		case "TIMER":
		case "COUNTER":
		case "CONTROL":
			return 0;
		case "X":
			return false;
		case "C":
		case "CHAR":
			// Convert to string.  
			return "";
		default:
			outputLog("Unknown data type when figuring out bad value - should never happen.  Should have been caught earlier.  " + this.datatype);
			return 0;
		}
	};
}

function itemListSorter(a, b) {
	// Feel free to manipulate these next two lines...
	if (a.areaPCCCCode < b.areaPCCCCode) { return -1; }
	if (a.areaPCCCCode > b.areaPCCCCode) { return 1; }
	
	// But for byte offset we need to start at 0.  
	if (a.offset < b.offset) { return -1; }
	if (a.offset > b.offset) { return 1; }
	
	// Then bit offset
	if (a.bitOffset < b.bitOffset) { return -1; }
	if (a.bitOffset > b.bitOffset) { return 1; }

	// Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
	if (a.byteLength > b.byteLength) { return -1; }
	if (a.byteLength < b.byteLength) { return 1; }
}

function doNothing(arg) {
	return arg;
}

function toABStructure(buf, offset, type) {
	var bits,retval = {};
	if (!buf) { return retval; }
	bits = buf.readInt16LE(offset);
	if (type === "TIMER") {
		retval.EN = ((bits & (1 << 15)) > 0);
		retval.TT = ((bits & (1 << 14)) > 0);
		retval.DN = ((bits & (1 << 13)) > 0);
		retval.PRE = buf.readInt16LE(offset+2);
		retval.ACC = buf.readInt16LE(offset+4);
	}
	if (type === "COUNTER") {
		retval.CU = ((bits & (1 << 15)) > 0);
		retval.CD = ((bits & (1 << 14)) > 0);
		retval.DN = ((bits & (1 << 13)) > 0);
		retval.OV = ((bits & (1 << 12)) > 0);
		retval.UN = ((bits & (1 << 11)) > 0);
		retval.PRE = buf.readInt16LE(offset+2);
		retval.ACC = buf.readInt16LE(offset+4);
	}
	if (type === "CONTROL") {
		retval.EN = ((bits & (1 << 15)) > 0);
		retval.EU = ((bits & (1 << 14)) > 0);
		retval.DN = ((bits & (1 << 13)) > 0);
		retval.EM = ((bits & (1 << 12)) > 0);
		retval.ER = ((bits & (1 << 11)) > 0);
		retval.UL = ((bits & (1 << 10)) > 0);
		retval.IN = ((bits & (1 << 9)) > 0);
		retval.FD = ((bits & (1 << 8)) > 0);
		retval.LEN = buf.readInt16LE(offset+2);
		retval.POS = buf.readInt16LE(offset+4);
	}
	return retval;
}
