nodePCCC
========

nodePCCC is a library that allows communication to certain Allen-Bradley PLCs - The SLC 500 series, Micrologix and ControlLogix/CompactLogix PLCs using PCCC embedded in Ethernet/IP.  This is not an official implementation of Ethernet/IP.  This is not affiliated with or supported by Allen-Bradley in any way.  CompactLogix, ControlLogix, SLC 500, 1761-NET-ENI are trademarks of Allen-Bradley.

WARNING - This is BETA CODE and you need to be aware that WRONG VALUES could be written to WRONG LOCATIONS.  Fully test everything you do.  In situations where writing to a random area of memory within the PLC could cost you money, back up your data and test this really well.  If this could injure someone or worse, consider other software.  

To use this on a SLC, you must have a SLC 5/05 with Ser A FRN 5 or later, or Ser C FRN 3 or later.  Earlier versions will not work. You may also use a 1761-NET-ENI module with a 5/03 and other processors supported by the ENI module.  This may work using an ENI module connected to a CompactLogix, although this combination hasn't been tested either.  It has been tested only on direct connection to newer SLC 5/05 CPUs, a 5/03 CPU with a 1761-NET-ENI module, a couple of CompactLogix and a much earlier version was tested on a ControlLogix.  Try at your own risk with other combinations.  Using this with a PLC5 will likely require a different DF1 command with different formatting.  Consult the DF1 manual (google it) for more details.  (The manual suggests reading is more likely to work than writing but we don't have access to a PLC-5 and can't test it.)  In any case, PLC-5-specific commands could certainly be added.

If you are using with a ControlLogix and possibly some CompactLogix, you likely need to specify the {routing: [0x01,0x00,0x01,0x00]} option (meaning path length 1, backplane port 0 of the ENBT module, path length 1, slot 0 of the 1756 backplane).  You can experiment with other paths to make requests from a SLC 5/04 over DH+, for example, but it may not work - we have not tried this.

On a CompactLogix or ControlLogix, you must go to the "Tools" menu in Logix 5000 and "Map PLC5/SLC messages" to map an array of values (only Float/Int/DINT have been tested) to a "file number" and then request that file number preferably with the corresponding type.   So if you create a variable called THEINTEGER with type INT[10] then map it to file 7 and download, you can request N7:0 to get the first element, and so on. 

Note that it is currently not possible to write to bits above 15 (most-significant word) in a long integer as the PCCC read-modify-write command appears to not support this.  You must write the entire DINT or use bits within an INT.

It is optimized in two ways - it sorts a large number of items being requested from the PLC and decides what overall data areas to request.  It does not yet group multiple small requests together in a single packet, which is apparently possible.  It does, however, send 2 packets at once, for speed, and this number could potentially be increased.   So a request for 100 different bits, all close (but not necessarily completely contiguous) will be grouped in one single request to the PLC, with no additional direction from the user.  Its optimizations are not likely tuned as well as some commercial OPC servers, however.

nodePCCC manages reconnects for you.  So if the connection is lost because the PLC is powered down or disconnected, you can continue to request data with no other action necessary.  "Bad" values are returned, and eventually the connection will be automatically restored.

nodePCCC is written entirely in Javascript, so no compiler installation is necessary on Windows, and deployment on other platforms (ARM, etc) should be no problem.

This was developed using Wireshark to help with packet format.  Allen Bradley's own documentation was helpful as well, such as the "DF1 manual".

To get started:

	npm install nodepccc

Example usage:

	var nodepccc = require('nodepccc');
	var conn = new nodepccc;
	var doneReading = false;
	var doneWriting = false;

	conn.initiateConnection({port: 44818, host: '192.168.8.106' /* , routing: [0x01,0x00,0x01,0x00] */}, connected);
	// Either uncomment the routing or uncomment this next line for ControlLogix/CompactLogix or if otherwise using routing	
	// First 0x01, 0x00 = 1 word in the path, second 0x01, 0x00 = Port 0x01 (backplane port of Ethernet module), 0x00 = PLC is in slot 0 in chassis.   

	function connected(err) {
		if (typeof(err) !== "undefined") {
			// We have an error.  Maybe the PLC is not reachable.  
			console.log(err);
			process.exit();
		}
		conn.setTranslationCB(tagLookup);
		conn.addItems(['TEST1', 'TEST4']);
		conn.addItems('TEST1');
	//	conn.removeItems(['TEST2', 'TEST3']);  // Demo of "removeItems".  
	//	conn.writeItems(['TEST5', 'TEST6'], [ 867.5309, 9 ], valuesWritten);  // You can write an array of items like this if you want.  
		conn.writeItems('TEST7', [ 666, 777 ], valuesWritten);  // You can write a single array item too.  
		conn.readAllItems(valuesReady);	
	}

	function valuesReady(anythingBad, values) {
		if (anythingBad) { console.log("SOMETHING WENT WRONG READING VALUES!!!!"); }
		console.log(values);
	// alternative syntax		console.log("Value is " + conn.findItem('TEST1').value + " quality is " + conn.findItem('TEST1').quality);
		doneReading = true;
		if (doneWriting) { process.exit(); }
	}

	function valuesWritten(anythingBad) {
		if (anythingBad) { console.log("SOMETHING WENT WRONG WRITING VALUES!!!!"); }
		console.log("Done writing.");
		doneWriting = true;
		if (doneReading) { process.exit(); }
	}

	// This is a very simple "tag lookup" callback function that would eventually be replaced with either a database findOne(), or a large array in memory.  
	// Note that the return value is a controller absolute address and datatype specifier.  
	// If you want to use absolute addresses only, you can do that too.  
	function tagLookup(tag) {
		switch (tag) {
		case 'TEST1':
			return 'N7:0';				// Integer
		case 'TEST2':
			return 'B3:0/0';			// Bit
		case 'TEST3':
			return 'B3/17';				// Same as B3:1/1
		case 'TEST4':
			return 'F8:0,20';  			// Yes this is an array...  20 real numbers.  
		case 'TEST5':
			return 'F8:1';				// Single real.  
		case 'TEST6':
			return 'F8:2';				// Another single real.  
		case 'TEST7':
			return 'N7:1,2';			// A couple of integers in an array  	
		case 'TEST8':
			return 'O:5/1';				// Direct output  	
		default:
			return undefined;
		}
	}

This returns some diagnostic output as well as the following:

	{ TEST1: 30724,
	  TEST4: 
	   [ 867530.875,
	     1,
	     97.0999984741211,
	     2.9000000953674316,
	     97,
	     0,
	     0,
	     19,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0,
	     0 ] }

### API
 - [initiateConnection()](#initiate-connection)
 - [dropConnection()](#drop-connection)
 - [setTranslationCB()](#set-translation-cb)
 - [addItems()](#add-items)
 - [removeItems()](#remove-items)
 - [writeItems()](#write-items)
 - [readAllItems()](#read-all-items)
 - [findItem()](#find-item)


#### <a name="initiate-connection"></a>nodepccc.initiateConnection(params, callback)
Connects to a PLC.  

params should be an object with the following keys:
- port (normally specify 44818)
- host (address)
- routing (array of characters specifying path length, path, etc.  Most common is [0x01, 0x00, 0x01, 0x00] for ControlLogix.)

`callback(err)` will be executed on success or failure.  err is either an error object, or undefined on successful connection.


#### <a name="drop-connection"></a>nodepccc.dropConnection()
Disconnects from a PLC.  

This simply terminates the TCP connection.  It does NOT do an Ethernet/IP disconnect at this time.


#### <a name="set-translation-cb"></a>nodepccc.setTranslationCB(translator)
Sets a callback for name - address translation.  

This is optional - you can choose to use "addItem" etc with absolute addresses.

If you use it, `translator` should be a function that takes a string as an argument, and returns a string in the following format:
`<type specifier><file number - I assumed 1, O assumed 0, S assumed 2>:<element>[</bit> or </DN, /EN, /TT> or <.ACC, .PRE>],array length`

Examples:
- F8:30
- F8:0,10 - array of 10 floating point numbers
- N7:12
- L9:1 - long integer is MicroLogix/ControlLogix/CompactLogix only
- N7:12/1 - second bit in the word
- B3:6/6
- T4:6.ACC - timer accumulator - read/write
- C5:1.PRE - counter preset - read/write
- T4:0,20 - array of timers - will return an array of objects representing 20 timers - READ ONLY
- R6:0.LEN - control length - read/write
- R6:0 - control structure - will return a JS object - READ ONLY

Note that some values are not supported in an array - timer presets and accumulators are an example, but entire timers are fine for READ ONLY.

In the example above, an object is declared and the `translator` references that object.  It could just as reference a file or database.  In any case, it allows cleaner Javascript code to be written that refers to a name instead of an absolute address.  

#### <a name="add-items"></a>nodepccc.addItems(items)
Adds `items` to the internal read polling list.  

`items` can be a string or an array of strings.

#### <a name="remove-items"></a>nodepccc.removeItems(items)
Removes `items` to the internal read polling list.  

`items` can be a string or an array of strings.

#### <a name="write-items"></a>nodepccc.writeItems(items, values)
Writes `items` to the PLC using the corresponding `values`.  

`items` can be a string or an array of strings.  If `items` is a single string, `values` should then be a single item (or an array if `items` is an array item).  If `items` is an array of strings, `values` must be an array.

#### <a name="read-all-items"></a>nodepccc.readAllItems(callback)
Reads the internal polling list and calls `callback` when done.  

`callback(err, values)` is called with two arguments - a boolean indicating if ANY of the items have "bad quality", and `values`, an object containing the values being read as keys and their value (from the PLC) as the value.

#### <a name="find-item"></a>nodepccc.findItem(item)
Returns the item object being searched for (by iterating through the array of items), or undefined if it isn't found in the item list.  This allows accessing item.value and item.quality.


