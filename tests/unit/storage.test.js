import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalStorage } from '../../src/lib/storage/local.js';
import { AppError } from '../../src/lib/errors.js';

describe('Local Storage', () => {
  let tmpDir;
  let storage;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monarch-storage-unit-'));
    storage = new LocalStorage(tmpDir);
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses paths resolving outside UPLOAD_DIR', async () => {
    const maliciousKeys = [
      '../escape.jpg',
      '../../etc/passwd',
      'folder/../../escape.jpg',
      '/etc/passwd',
    ];

    for (const key of maliciousKeys) {
      await assert.rejects(
        async () => {
          await storage.save(key, Buffer.from('test'));
        },
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'PATH_TRAVERSAL_REFUSED');
          return true;
        }
      );

      assert.throws(
        () => {
          storage.createReadStream(key);
        },
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'PATH_TRAVERSAL_REFUSED');
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await storage.remove(key);
        },
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'PATH_TRAVERSAL_REFUSED');
          return true;
        }
      );
    }
  });

  it('saves, reads, and removes files correctly within UPLOAD_DIR', async () => {
    const key = 'tenancy-123/photo.jpg';
    const content = Buffer.from('photo-bytes-test');

    await storage.save(key, content);

    const stream = storage.createReadStream(key);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const readBuffer = Buffer.concat(chunks);
    assert.deepEqual(readBuffer, content);

    await storage.remove(key);
    assert.throws(() => storage.createReadStream(key), /ENOENT/);
  });
});
