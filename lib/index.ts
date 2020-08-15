/* --------------------
 * Copyright(C) Matthias Behr, 2020.
 */

import fs from 'fs';
import yauzl from 'yauzl';
import { assert } from 'console';
import { Readable } from 'stream';
import tmp from 'tmp';

tmp.setGracefulCleanup();

export function test(): string {
    return 'test ok';
}

export class DirEnt {
    private _localHeader: Buffer | undefined = undefined;
    private _tmpFile: tmp.FileResult | undefined = undefined;

    constructor(private _zipfile: yauzl.ZipFile, private _entry: yauzl.Entry, private _offsetFileHeader: number, private _filePath: string, private _reader: MultiDiskRandomAccessReader | undefined = undefined) {
        console.log(`DirEnt(entry.fileName='${_entry.fileName}')`);
    }
    get name(): string { return this._entry.fileName; }
    get size(): number { return this._entry.uncompressedSize; } // provide uncompressed size
    get crc32(): number { return this._entry.crc32; }
    get compressionMethod(): number { return this._entry.compressionMethod; }

    get entry() { return this._entry; }

    private readInteral(buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void) {
        if (this._reader) {
            this._reader.read(buffer, offset, length, position, callback);
        } else {
            // read from path directly
            const fd = fs.openSync(this._filePath, 'r');
            const didRead = fs.readSync(fd, buffer, offset, length, position);
            fs.closeSync(fd); // todo can cache the fds.
            callback(undefined, didRead, buffer);
        }
    }

    private readLocalHeader(callback: (err?: Error) => void) {
        if (this._localHeader !== undefined) { callback(); return; } // todo has a racecond!
        //console.log(`readLocalHeader(dirEnt.name=${this.name}, _offsetFileHeader=${this._offsetFileHeader}), compressedSize=${this._entry.compressedSize}`);
        // we do need to check whether its a multi disk zip first. as relativeOffsetOfLocalHeader is relative to the disk...
        const centralFileHeaderBuf = Buffer.allocUnsafe(46);
        this.readInteral(centralFileHeaderBuf, 0, centralFileHeaderBuf.length, this._offsetFileHeader, (err, bytesRead) => {
            if (err) { callback(err); return; }
            var signature = centralFileHeaderBuf.readUInt32LE(0);
            if (signature !== 0x02014b50) return callback(Error("invalid central directory file header signature: 0x" + signature.toString(16)));

            // check diskNumber
            const diskNumber = centralFileHeaderBuf.readUInt16LE(34);
            //console.log(` got diskNumber=${diskNumber}`);

            const localHeaderOffset = this._entry.relativeOffsetOfLocalHeader + (this._reader ? this._reader.offsetOfDisk(diskNumber) : 0);
            if (localHeaderOffset != this._entry.relativeOffsetOfLocalHeader) { console.log(` changing relativeOffsetOfLocalHeader from ${this._entry.relativeOffsetOfLocalHeader} to ${localHeaderOffset}`); }
            this._entry.relativeOffsetOfLocalHeader = localHeaderOffset;
            const tempBuf = Buffer.allocUnsafe(30);
            this.readInteral(tempBuf, 0, tempBuf.length, localHeaderOffset, (err, bytesRead) => {
                if (err) { callback(err); return; }
                if (bytesRead != tempBuf.length) callback(Error(`readLocalHeader got ${bytesRead} expected ${tempBuf.length}`));
                this._localHeader = tempBuf;
                callback();
            });
        });
    }

    read(buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void) {
        console.log(`dirEnt.read(dirEnt.name=${this.name} .comprM=${this.compressionMethod}, offset=${offset}, length=${length}, position=${position})...`);
        this.readLocalHeader((err) => {
            if (err) { callback(err, 0, buffer); } else {
                // we do have a local header now
                assert(this._localHeader);
                var signature = this._localHeader!.readUInt32LE(0);
                if (signature !== 0x04034b50) {
                    return callback(new Error("dirEnt.read: invalid local file header signature: 0x" + signature.toString(16)), 0, buffer);
                }
                var fileNameLength = this._localHeader!.readUInt16LE(26);
                // 28 - Extra field length (m)
                var extraFieldLength = this._localHeader!.readUInt16LE(28);
                // 30 - File name
                // 30+n - Extra field
                var localFileHeaderEnd = this._entry.relativeOffsetOfLocalHeader + this._localHeader!.length + fileNameLength + extraFieldLength;
                var fileDataStart = localFileHeaderEnd;
                var fileDataEnd = fileDataStart + this._entry.compressedSize;
                console.log(`fileData(dirEnt.name=${this.name})=[${fileDataStart},${fileDataEnd})`);
                // compressed?
                if (this.compressionMethod === 0) { // no compression
                    if (fileDataStart + position >= fileDataEnd) { return callback(Error(`EOF`), 0, buffer); }
                    const toCopy = Math.min(length, fileDataEnd - (fileDataStart + position));
                    //console.log(`toCopy=${toCopy} [${fileDataStart + position},${fileDataStart + position + toCopy})`);
                    this.readInteral(buffer, offset, toCopy, fileDataStart + position, callback);
                } else if (this.compressionMethod === 8) { // deflate
                    if (position >= this._entry.uncompressedSize) { return callback(Error('EOF'), 0, buffer); }
                    const toCopy = Math.min(length, this._entry.uncompressedSize - position);
                    // for now use a simple implementation that extracts the file into a tmp file.
                    if (this._tmpFile !== undefined) { // we have file data already
                        return fs.read(this._tmpFile.fd, buffer, offset, toCopy, position, (err, bytesRead) => {
                            callback(err !== null ? err : undefined, bytesRead, buffer);
                        });
                    } else {
                        // create tmpfile and fill with data:
                        this._tmpFile = tmp.fileSync();
                        if (this._tmpFile) {
                            console.log(` created tmp file '${this._tmpFile.name}' with fd=${this._tmpFile.fd}`);
                            this._zipfile.openReadStream(this._entry, (err, stream) => {
                                if (err || !this._tmpFile || !stream) { this._tmpFile?.removeCallback(); this._tmpFile = undefined; return callback(err, 0, buffer); }
                                const writeStream = fs.createWriteStream('', { fd: this._tmpFile.fd });
                                writeStream.on("finish", () => {
                                    const stats = fs.statSync(this._tmpFile!.name);
                                    // console.log(` finish: wrote all data to tmpFile! stats.size=${stats.size}`);
                                    fs.read(this._tmpFile!.fd, buffer, offset, toCopy, position, (err, bytesRead) => {
                                        callback(err !== null ? err : undefined, bytesRead, buffer);
                                    });
                                });
                                //stream.on("end" // ignore, we need to wait for writeStream to finish writing
                                stream.on("error", (err) => {
                                    callback(err, 0, buffer);
                                });
                                stream.pipe(writeStream);
                            });
                        } else { callback(Error('failed to create tmp.fileSync'), 0, buffer); }
                    }
                } else {
                    callback(Error(`not supported compressionMethod=${this.compressionMethod}`), 0, buffer);
                    return;
                }
            }
        });
    }
}

// try to mimic similar api as fs.Dir
export class Dir {
    constructor(readonly path: string, private _zipfile: yauzl.ZipFile, private _reader: MultiDiskRandomAccessReader | undefined = undefined) {
        console.log(`Dir(path='${path}')`);
        _zipfile.on("end", () => {
            //console.log(`got end event`);
        });
    }
    read(callback?: ((err: Error | undefined, dirEnt: DirEnt | null) => void)) {
        if (callback) {
            const oldReadEntryCursor = <number><unknown>(this._zipfile.readEntryCursor);
            this._zipfile.once("entry", (entry) => {
                callback(undefined, new DirEnt(this._zipfile, entry, oldReadEntryCursor, this.path, this._reader));
            });
            this._zipfile.once("end", () => callback(undefined, null));
            this._zipfile.readEntry(); // take care: with RandomAccessReader this seems to be needed after the .on/.once ...
        } else {
            return new Promise<DirEnt | null>((resolve, reject) => {
                this.read((err, dirEnt) => {
                    if (err) reject(err); else resolve(dirEnt);
                });
            });
        }
    }

    [Symbol.asyncIterator]() {
        const readFn = this;
        return {
            next() {
                //console.log(`Dir.asyncIterator.next()...`);
                return new Promise<{ value: DirEnt | null, done: Boolean }>((resolve, reject) => {
                    readFn.read((err, dirEnt) => {
                        if (err) reject(err); else resolve({ value: dirEnt, done: dirEnt === null })
                    });
                });
            }
        }
    }
    // todo close()?
}

class MultiDiskRandomAccessReader extends yauzl.RandomAccessReader {
    private _files: { path: string, size: number, offset: number }[] = [];
    readonly totalSize: number;
    constructor(path: string, nrDisks: number) {
        super();
        console.log(`MultiDiskRandomAccessReader(path='${path}', nrDisks=${nrDisks})`);

        // verify that we do have nrDisks file:
        // .z01 .. .z<nrDisks-1>, .zip
        const basePath = path.slice(0, -2);
        console.log(` basePath='${basePath}'`);
        let offset = 0;
        for (let i = 1; i <= nrDisks; ++i) {
            const fPath = i < nrDisks ? basePath + i.toString().padStart(2, '0') : path;
            const stat = fs.statSync(fPath);
            console.log(` fPath='${fPath}' stat=${stat.size} offset=${offset}`);
            this._files.push({ path: fPath, size: stat.size, offset: offset });
            offset += stat.size;
        }

        this.totalSize = this._files.reduce<number>((prev: number, curr) => { return prev + curr.size; }, 0);
        console.log(` totalSize = ${this.totalSize}`);
    }

    offsetOfDisk(diskNr: number) {
        if (diskNr >= 0 && diskNr < this._files.length) { return this._files[diskNr].offset; }
        return 0;
    }

    _readStreamForRange(start: number, end: number) {
        //console.log(` readStreamForRange(${start}, ${end}})...`);
        const copyData = {
            dirEnt: this,
            copied: 0
        };
        return new Readable({
            read(size) {
                const buffer = Buffer.allocUnsafe(1024 * 1024);
                const toCopy = Math.min(buffer.length, (end - start) - copyData.copied);
                //console.log(`readStreamForRange.read(${size})... start=${start}, end=${end}, copied=${copyData.copied}, toCopy=${toCopy}`);
                if (toCopy <= 0) { this.push(null); return; }
                copyData.dirEnt.read(buffer, 0, toCopy, start + copyData.copied, (err, bytesRead) => {
                    if (err) throw err;
                    copyData.copied += bytesRead;
                    //console.log(`readStreamForRange.read got copied=${copyData.copied}, bytesRead=${bytesRead}`);
                    if (this.push(buffer.slice(0, bytesRead))) {
                        // we shall keep on reading until push returns false.
                        setImmediate(() => this.read(size));
                    }
                });
            }
        });
    }
    read(buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void) {
        //console.log(` read(buffer=${buffer instanceof Buffer}, offset=${offset}, length=${length}, position=${position}})...`);
        // simple read function:
        // search file to read from:
        let read: number = 0;
        let i = 0;
        let skipped = 0;
        while (read < length && i < this._files.length) {
            const fData = this._files[i];
            if (position + read < skipped + fData.size) {
                // copy from this file! how many bytes?
                const offsetInFile = position + read - skipped;
                const toCopy = Math.min(length - read, fData.size - offsetInFile);
                //console.log(` copying ${toCopy} bytes from ${fData.path} [${offsetInFile}-${offsetInFile + toCopy})`);
                const fd = fs.openSync(fData.path, 'r');
                const didRead = fs.readSync(fd, buffer, offset + read, toCopy, offsetInFile);
                fs.closeSync(fd); // todo can cache the fds.
                assert(didRead <= toCopy);
                read += didRead;
            }
            skipped += fData.size;
            i++;
        }

        // check whether we do need to modify the EOCDR for the multi-disk:
        // todo would be easier to add an option to yauzl to ignore diskNumber
        // for now use the snippet from yauzl to determine the EOCDR and diskNumber
        if (length + position >= this.totalSize) {
            //console.log(`searching for EOCDR...`);
            for (var j = length - 22; j >= 0; j -= 1) {
                if (buffer.readUInt32LE(j) !== 0x06054b50) continue;
                // found eocdr
                var eocdrBuffer = buffer.slice(j);

                // 0 - End of central directory signature = 0x06054b50
                // 4 - Number of this disk
                var diskNumber = eocdrBuffer.readUInt16LE(4);
                if (diskNumber !== 0) {
                    if (diskNumber <= this._files.length) {
                        console.log(` modified diskNumber=${diskNumber} to 0`);
                        eocdrBuffer.writeUInt16LE(0, 4);
                        var centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);
                        // we keep the same distance to the end of the last file:
                        const newCDO = this.totalSize - (this._files[this._files.length - 1].size - centralDirectoryOffset);
                        console.log(` modified centralDirectoryOffset=${centralDirectoryOffset} to ${newCDO}`);
                        eocdrBuffer.writeUInt32LE(newCDO, 16);
                    } else {
                        console.warn(` didn't modify the diskNumber(${diskNumber}) as it didn't match our expected diskNumber(${this._files.length})!`);
                    }
                }
                break;
            }
            //console.log(`searching for EOCDR...done`);
        }
        //console.log(` read...done`);
        callback(undefined, read, buffer);
    }
}

export function opendir(path: string, options: { encoding?: string }, callback: (err: Error | undefined, dir?: Dir | undefined) => void) // todo path as Buffer | URL
{

    // check for known file extensions:
    if (path.match(/\.7z$/)) {
        callback(Error(`no supported file extension`), undefined);
        return;
    }
    if (path.match(/\.zip$/)) {
        // open with yauzl:
        yauzl.open(path, { lazyEntries: true }, (err, zipfile) => { // todo think about autoClose: false and once("end", zipfile.close())
            //console.log(`yauzl.open callback(err = '${err}', zipfile = ${zipfile}`);
            // check if it was rejected due to multi-disk:
            if (err && err.message.includes('multi-disk zip files')) {
                // we provide as one big file using a RandomAccessReader
                const match = err.message.match(/found disk number: (\d+)$/);
                const nrDisks: number = Number.parseInt((match && match.length === 2) ? match[1] : '0');
                if (nrDisks <= 0) { callback(Error(`unexpected nr disks(${nrDisks}) from '${err.message}' match = ${match} match.length = ${match?.length}`)); return; }
                try {
                    const reader = new MultiDiskRandomAccessReader(path, nrDisks + 1); // nrDisk is 0 indexed
                    yauzl.fromRandomAccessReader(reader, reader.totalSize, { lazyEntries: true }, (err, zipfile) => {
                        //console.log(`yauzl.fromRandomAccessReader callback(err = '${err}', zipfile = ${zipfile}`);
                        if (err) { callback(err); return; }
                        if (!zipfile) { callback(Error('unexpected !zipfile')); return; }
                        callback(undefined, new Dir(path, zipfile, reader));
                    });
                } catch (err) {
                    callback(err);
                }
            } else {
                if (err) { callback(err); return; }
                if (!zipfile) { callback(Error('unexpected !zipfile')); return; }
                callback(undefined, new Dir(path, zipfile));
            }
        });
        return;
    }
    if (path.match(/\.zip\.(\d+)$/)) { // e.g. .zip.001 for 7zip the last file needs to be opened (7zip requests the first file...)
        // open with yauzl directly via MultiDiskRandomAccessReader:
        const match = path.match(/\.zip\.(\d+)$/);
        const nrDisks: number = Number.parseInt((match && match.length === 2) ? match[1] : '0');
        if (nrDisks <= 0) { callback(Error(`unexpected nr disks(${nrDisks}) from '${path}' match = ${match} match.length = ${match?.length}`)); return; }
        try {
            const reader = new MultiDiskRandomAccessReader(path, nrDisks);
            yauzl.fromRandomAccessReader(reader, reader.totalSize, { lazyEntries: true }, (err, zipfile) => {
                //console.log(`yauzl.fromRandomAccessReader callback(err = '${err}', zipfile = ${zipfile}`);
                if (err) { callback(err); return; }
                if (!zipfile) { callback(Error('unexpected !zipfile')); return; }
                callback(undefined, new Dir(path, zipfile, reader));
            });
        } catch (err) {
            callback(err);
        }
        return;
    }

    callback(Error(`no supported file extension`), undefined);
}

export function read(dirEnt: DirEnt, buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void) {
    //console.log(`read(dirEnt.name=${dirEnt.name} .comprM=${dirEnt.compressionMethod}, offset=${offset}, length=${length}, position=${position})...`);
    dirEnt.read(buffer, offset, length, position, callback);
}