/* --------------------
 * Copyright(C) Matthias Behr, 2020.
 */

import { opendir, read } from '../lib/index';
import 'mocha';
import fs from 'fs';
import assert from 'assert';

describe('read function', () => {
    it('should read uncompressed file from zip', function (done) {
        this.timeout(1000);
        // test4.zip was created with 'zip -s 1m test4.zip randfile.bin nullfile.bin'
        // randfile.bin was created using 'dd if=/dev/random of=randfile.bin bs=1m count=10'
        // nullfile.bin with if=/dev/zero
        opendir('test/data/test5.zip', {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);
            const promDirEnt = dir.read();
            assert(promDirEnt, 'received no Promise');
            await promDirEnt.then((dirEnt) => {
                assert(dirEnt, `got no dirEnt`);
                assert(dirEnt.name === 'randfile.bin', `expected randfile.bin got '${dirEnt.name}'`);
                const toRead = dirEnt.size;
                const buffer = Buffer.allocUnsafe(toRead);
                read(dirEnt, buffer, 0, toRead, 0, (err, bytesRead, buffer) => {
                    assert(!err, `got unexpected err=${err}`);
                    assert(bytesRead === toRead, `expected bytesRead=${toRead} but got ${bytesRead}`);
                    // compare content:
                    const fd = fs.openSync('test/data/randfile.bin', 'r');
                    const bufferOrg = Buffer.allocUnsafe(toRead); // todo better stat.size
                    const didRead = fs.readSync(fd, bufferOrg, 0, toRead, 0);
                    fs.closeSync(fd);
                    assert(0 === buffer.compare(bufferOrg), `randfile comparision failed`);
                    done();
                });
            }).catch((reason) => {
                assert(false, `got rejection '${reason}'`);
                done();
            });
        });
    });

    it('should read compressed file from zip', function (done) {
        this.timeout(5000);
        // test4.zip was created with 'zip -s 1m test4.zip randfile.bin nullfile.bin'
        // randfile.bin was created using 'dd if=/dev/random of=randfile.bin bs=1m count=10'
        // nullfile.bin with if=/dev/zero
        opendir('test/data/test4.zip', {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);

            let nrFiles = 0;
            const expValues = [{ name: 'randfile.bin', path: 'test/data/randfile.bin' }, { name: 'nullfile.bin', path: 'test/data/nullfile.bin' }]
            for await (const dirEnt of dir) {
                assert(nrFiles < 2);
                assert(dirEnt);
                assert(dirEnt.name === expValues[nrFiles].name, `expected ${expValues[nrFiles].name} got '${dirEnt.name}'`);
                const toRead = dirEnt.size;
                const buffer = Buffer.allocUnsafe(toRead);
                let nrFilesCopy = nrFiles; // need to copy for the callback...
                read(dirEnt, buffer, 0, toRead, 0, (err, bytesRead, buffer) => {
                    assert(nrFilesCopy < 2);
                    assert(!err, `got unexpected err=${err}`);
                    assert(bytesRead === toRead, `expected bytesRead=${toRead} but got ${bytesRead}`);
                    // compare content:
                    const stats = fs.statSync(expValues[nrFilesCopy].path);
                    //console.log(`randfile.bin has size ${stats.size}`);
                    assert(stats.size === bytesRead, `${expValues[nrFilesCopy].name} has wrong size`);
                    const fd = fs.openSync(expValues[nrFilesCopy].path, 'r');
                    const bufferOrg = Buffer.allocUnsafe(toRead); // todo better stat.size
                    const didRead = fs.readSync(fd, bufferOrg, 0, toRead, 0);
                    fs.closeSync(fd);
                    assert(0 === buffer.compare(bufferOrg), `${expValues[nrFilesCopy].name} comparision failed`);
                    if (nrFilesCopy === 1) done();
                });
                nrFiles++;
            }
        });
    });

    it('should extract files from 7zip stored in split zip format', function (done) {
        this.timeout(5000);
        opendir('test/data/test8.zip.006', {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);

            let nrFiles = 0;
            const expValues = [{ name: 'nullfile.bin' }, { name: 'randfile.bin' }];
            let verifiedCrc = 0;

            for await (const dirEnt of dir) {
                assert(nrFiles < 2);
                assert(dirEnt);
                assert(dirEnt.name === expValues[nrFiles].name, `expected ${expValues[nrFiles].name} got '${dirEnt.name}'`);
                const buffer = Buffer.allocUnsafe(dirEnt.size);
                const dirEntCrc32 = dirEnt.crc32;
                nrFiles++;
                read(dirEnt, buffer, 0, buffer.length, 0, (err, bytesRead, buffer) => {
                    assert(!err, `got unexpected err=${err}`);
                    assert(bytesRead === buffer.length, `expected bytesRead=${buffer.length} but got ${bytesRead}`);
                    assert(crc32(buffer, 0) === dirEntCrc32, 'crc32 mismatch')
                    verifiedCrc++;
                    if (verifiedCrc === nrFiles) { done(); }
                });
            }
        });
    });

});


// straight forward crc32 impl.
let crcTable: Int32Array | undefined = undefined;
function calcCrcTable() {
    if (crcTable === undefined) { crcTable = new Int32Array(256); }
    for (let n = 0; n <= 255; ++n) {
        let crc = n;
        for (let i = 0; i <= 7; ++i) {
            if (crc & 0x1) {
                crc = (crc >>> 1) ^ 0xEDB88320;
            } else {
                crc = (crc >>> 1);
            }
        }
        crcTable[n] = crc;
    }
}

function crc32(buf: Buffer | string, initial: number) {
    if (crcTable === undefined) {
        calcCrcTable();
        assert(crcTable);
        const crcTest = crc32('123456789', 0);
        //console.log(`crc32('123456789',0)=${crcTest.toString(16)}`);
        assert(crcTest === 0xcbf43926, 'crc32b("123456789") doesnt match!');
    }
    if (!Buffer.isBuffer(buf)) {
        buf = Buffer.from(buf);
    }
    let crc = (initial | 0) ^ -1;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
};
