import { test } from '../lib/index';
import 'mocha';
import assert from 'assert';

describe('example function', () => {

    it('should return test ok', () => {
        const result = test();
        assert(result === 'test ok');
    });

});
