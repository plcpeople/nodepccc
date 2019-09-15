# Change Log
All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

## [0.1.16] - 2019-09-14
### Changed
- More changes to reset for Node Red compatibility

## [0.1.15] - 2019-09-08
### Changed
- Modified read/write timeout again for improved reliability on reconnect

## [0.1.14] - 2019-08-21
### Changed
- Modified read/write timeout to do a reset

## [0.1.13] - 2019-02-11
### Fixed
- Bug in prepareReadPacket related to packet length fixed (Thanks to Lucasrsv1)
- Bad quality details added to writeDoneCallback (Thanks to Lucasrsv1)

## [0.1.12] - 2018-12-17
### Fixed
- Ghost write issue (Thanks to Lucasrsv1)

## [0.1.11] - 2018-11-20
### Fixed
- Compile issue.

## [0.1.10] - 2018-11-20
### Fixed
- #26: Fixed issue with not indicating bad quality on write
- Fixed issue writing any values with an offset within the file > 254.
- Fixed issues reconnecting when writing
- Better indication when a write is requested and it will be lost
- Better support of NSTRING arrays
- Better support of long arrays of all types

## [0.1.9] - 2018-10-24
### Fixed
- #25: Fixed issue reading any values with an offset within the file > 254.

## [0.1.8] - 2018-05-31
### Fixed
- #24: Fixed node throwing error on failed write due to loss of communication with PLC.

## [0.1.7] - 2017-10-05
### Fixed
- #15: Fixed node throwing with ECONNRESET because socket was not properly cleaned up

### Added
 - NodePCCC accepts an object with `debug` and `silent` options for controlling verbosity
 - Removed dependency to underscore

## [0.1.6] - 2017-02-27
### Fixed
- Fixed incorrect information in README section that talks about path/routing
- Fixed the possibility of not returning from readAllItems if PLC initiates a disconnect

## [0.1.5] - 2016-11-13
### Fixed
- Bug fix for reading/writing bit arrays (thanks to Jotan)
- Bug fix for arrays of bits in long integers
- Improvements and documentation for NSTRING data type to read strings from Control/CompactLogix
- DropConnection improvements thanks to dom-white
- Fixed a bug writing odd length strings

### Added
- Experimental NString datatype support to allow reading strings from Control/CompactLogix that does not support ST files

## [0.1.4] - 2016-01-13
### Fixed
- Odd-length string bug fix (thanks to Julien Ledun).
- MIT license mentioned in package.json

### Added
- Experimental NString datatype support to allow reading strings from Control/CompactLogix that does not support ST files

## [0.1.3] - 2015-07-12
### Fixed
- Log error writing array of TIMER/COUNTER/CONTROL that has never been supported.
- Return a JS object with TIMER/COUNTER/CONTROL data (.PRE, .ACC etc) when an entire timer or counter or control is requested without a subelement or when an array is requested.
- Fix for timer/counter .PRE not working at all when requested individually

### Added
- String datatype support
- Control (R) structure datatype support

