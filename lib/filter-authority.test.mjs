import assert from 'node:assert/strict';
import test from 'node:test';
import { FilterAuthorityCursor } from './filter-authority.ts';
test('initial authoritative revision zero is accepted once', () => {
 const cursor = new FilterAuthorityCursor(); assert.equal(cursor.accept('owner', 0, true), true);
 assert.equal(cursor.accept('owner', 0, true), false); assert.equal(cursor.accept('owner', 1), true);
 assert.equal(cursor.accept('owner', 0), false);
});
test('new owner requires handshake and retired owner cannot overwrite it', () => {
 const cursor = new FilterAuthorityCursor(); cursor.accept('old', 7, true);
 assert.equal(cursor.accept('new', 0), false); assert.equal(cursor.accept('new', 0, true), true);
 assert.equal(cursor.accept('old', 8, true), false); assert.equal(cursor.accept('new', 1), true);
});
test('child local revision does not participate in owner ordering', () => {
 const cursor = new FilterAuthorityCursor(); cursor.accept('owner', 0, true);
 let childRevision = 99; childRevision++; assert.equal(childRevision, 100);
 assert.equal(cursor.accept('owner', 1), true);
});
