import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { AppError } from '../errors.js';

export class LocalStorage {
  constructor(uploadDir = config.uploadDir) {
    this.uploadDir = path.resolve(uploadDir);
  }

  _resolvePath(key) {
    if (!key || typeof key !== 'string') {
      throw new AppError(400, 'INVALID_KEY', 'Invalid storage key');
    }

    const resolved = path.resolve(this.uploadDir, key);
    const relative = path.relative(this.uploadDir, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AppError(
        400,
        'PATH_TRAVERSAL_REFUSED',
        'Path traversal outside upload directory refused'
      );
    }

    return resolved;
  }

  async save(key, buffer) {
    const targetPath = this._resolvePath(key);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, buffer);
    return { path: targetPath };
  }

  createReadStream(key) {
    const targetPath = this._resolvePath(key);
    if (!fs.existsSync(targetPath)) {
      const err = new Error(
        `ENOENT: no such file or directory, open '${targetPath}'`
      );
      err.code = 'ENOENT';
      throw err;
    }
    return fs.createReadStream(targetPath);
  }

  async remove(key) {
    const targetPath = this._resolvePath(key);
    try {
      await fsPromises.unlink(targetPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export function createStorage(uploadDir) {
  return new LocalStorage(uploadDir);
}

export const storage = new LocalStorage();

export const save = (key, buffer) => storage.save(key, buffer);
export const createReadStream = (key) => storage.createReadStream(key);
export const remove = (key) => storage.remove(key);

export default storage;
