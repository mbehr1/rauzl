# rauzl
Random Access UnZip Library

## Features
- allows to open files contained in a zip file without extracting them (currently deflated files will be extracted to a tmp dir)
- allows non-streaming / random-access to the files
- support multi-disk zip files created by zip -s or e.g. 7zip but stored in zip format.
