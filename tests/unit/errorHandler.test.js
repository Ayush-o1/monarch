import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../../src/middleware/errorHandler.js';

describe('Error Handler (unit logic)', () => {
  function createMockResponse() {
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
    };
    return res;
  }

  it('maps a pg error with message starting with "LOCKED: ..." to 409 INSPECTION_LOCKED', () => {
    const err = new Error(
      'LOCKED: parent inspection is not in draft status (current: submitted)'
    );
    const req = {};
    const res = createMockResponse();

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'INSPECTION_LOCKED');
    assert.match(res.body.error.message, /parent inspection is not in draft/);
  });

  it('maps a pg error with 23505 unique violation on items to 409 DUPLICATE_ITEM', () => {
    const err = new Error(
      'duplicate key value violates unique constraint "inspection_items_inspection_id_lower_room_lower_name_idx"'
    );
    err.code = '23505';
    err.constraint = 'inspection_items_inspection_id_lower_room_lower_name_idx';
    const req = {};
    const res = createMockResponse();

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, 'DUPLICATE_ITEM');
  });
});
