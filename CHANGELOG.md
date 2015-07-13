# Change Log
All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

## [0.1.3] - 2015-07-12
### Fixed
- Log error writing array of TIMER/COUNTER/CONTROL that has never been supported.
- Return a JS object with TIMER/COUNTER/CONTROL data (.PRE, .ACC etc) when an entire timer or counter or control is requested without a subelement or when an array is requested.
- Fix for timer/counter .PRE not working at all when requested individually

### Added
- String datatype support
- Control (R) structure datatype support

