/* --------------------
 * Copyright(C) Matthias Behr, 2020.
 */

import { opendir } from '../lib/index';
import 'mocha';
import assert from 'assert';

describe('opendir function', () => {

    it('should return error on unknown extension', () => {
        opendir(`bla`, {}, (err, dir) => {
            assert(!!err);
            assert(dir === undefined, `dir object should be undefined`);
        });
    });

    it('should return error on known extension but not existing file', () => {
        opendir(`ENOENT.zip`, {}, (err, dir) => {
            assert(err && err.message.includes(`ENOENT`), `got unexpected err=${err}`);
            assert(dir === undefined, `dir object should be undefined`);
        });
    });

    it('should return error on known extension, existing file wo central dir structure', () => {
        opendir(`test/data/test1.zip`, {}, (err, dir) => {
            assert(err && err.message.includes(`end of central directory record signature not found`), `got unexpected err=${err}`);
            assert(dir === undefined, `dir object should be undefined`);
        });
    });

    it('should return no error on known extension and existing zip file', () => {
        opendir(`test/data/test2.zip`, {}, (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);
        });
    });

    it('should provide Dir info on known extension and existing zip file', (done) => {
        opendir(`test/data/test2.zip`, {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);
            assert(dir.path === 'test/data/test2.zip');
            const promDirEnt = dir.read();
            assert(promDirEnt, 'received no Promise');
            promDirEnt.then((dirEnt) => {
                assert(dirEnt, `got no dirEnt`);
                assert(dirEnt.name === 'data/test1.zip', `expected data/test1.zip got '${dirEnt.name}'`);
                done();
            }).catch((reason) => {
                assert(false, `got rejection '${reason}'`);
                done();
            });
        });
    });

    it('should provide just 1 Dir info on zip with 1 file', function (done) {
        this.timeout(1000);
        opendir(`test/data/test2.zip`, {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);
            const promDirEnt = dir.read();
            assert(promDirEnt, 'received no Promise');
            await promDirEnt.then((dirEnt) => { // todo yauzl got a bug here and returns the same entry twice if not awaiting the first one...
                assert(dirEnt, `got no dirEnt`);
                assert(dirEnt.name === 'data/test1.zip', `expected data/test1.zip got '${dirEnt.name}'`);
            }).catch((reason) => {
                assert(false, `got rejection '${reason}'`);
            });
            const promDirEnt2 = dir.read();
            assert(promDirEnt2, 'received no 2nd Promise');
            promDirEnt2.then((dirEnt) => {
                assert(!dirEnt, `got 2nd dirEnt`);
                done();
            }).catch((reason) => {
                assert(false, `got 2 rejection '${reason}'`);
                done();
            });
        });
    });

    it('should async iterate over the dir entries', function (done) {
        this.timeout(1000);
        opendir(`test/data/test5.zip`, {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);

            let nrFiles = 0;
            for await (const dirEnt of dir) {
                assert(dirEnt, 'received no Promise');
                //console.log(`dirEnt.name=${dirEnt.name}`);
                nrFiles++;
            }
            assert(nrFiles === 2, `expected 2 files but got ${nrFiles}`)
            done();
        });
    });

    // todo add test with read (callback)...

    it('should read split zip files from zip -s', function (done) {
        this.timeout(5000);
        // test4.zip was created with 'zip -s 1m test4.zip randfile.bin nullfile.bin'
        // randfile.bin was created using 'dd if=/dev/random of=randfile.bin bs=1m count=10'
        // nullfile.bin with if=/dev/zero
        opendir('test/data/test4.zip', {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);
            const promDirEnt = dir.read();
            assert(promDirEnt, 'received no Promise');
            await promDirEnt.then((dirEnt) => { // todo yauzl got a bug here and returns the same entry twice if not awaiting the first one...
                assert(dirEnt, `got no dirEnt`);
                assert(dirEnt.name === 'randfile.bin', `expected randfile.bin got '${dirEnt.name}'`);
            }).catch((reason) => {
                assert(false, `got rejection '${reason}'`);
            });
            const promDirEnt2 = dir.read();
            assert(promDirEnt2, 'received no 2nd Promise');
            promDirEnt2.then((dirEnt) => {
                assert(dirEnt, `got no 2nd dirEnt`);
                assert(dirEnt.name === 'nullfile.bin', `expected nullfile.bin got '${dirEnt.name}'`);
                done();
            }).catch((reason) => {
                assert(false, `got 2 rejection '${reason}'`);
                done();
            });
        });
    });

    /* todo: not supported yet!
    it('should read zip files from 7zip stored in 7z format', function (done) {
        this.timeout(5000);
        opendir('test/data/test6.7z', {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);

            let nrFiles = 0;
            const expValues = [{ name: 'nullfile.bin' }, { name: 'randfile.bin' }]
            for await (const dirEnt of dir) {
                assert(nrFiles < 2);
                assert(dirEnt);
                assert(dirEnt.name === expValues[nrFiles].name, `expected ${expValues[nrFiles].name} got '${dirEnt.name}'`);
                nrFiles++;
            }
            assert(nrFiles === expValues.length);
            done();

        });
    }); */

    it('should read split zip files from 7zip stored in zip format', function (done) {
        this.timeout(5000);
        opendir('test/data/test8.zip.006', {}, async (err, dir) => {
            assert(!err, `got unexpected err=${err}`);
            assert(dir, `dir object should be valid`);

            let nrFiles = 0;
            const expValues = [{ name: 'nullfile.bin' }, { name: 'randfile.bin' }]
            for await (const dirEnt of dir) {
                assert(nrFiles < 2);
                assert(dirEnt);
                assert(dirEnt.name === expValues[nrFiles].name, `expected ${expValues[nrFiles].name} got '${dirEnt.name}'`);
                nrFiles++;
            }
            assert(nrFiles === expValues.length);
            done();
        });
    });

});
