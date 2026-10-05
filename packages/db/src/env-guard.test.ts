import { describe, it, expect } from 'vitest';
import { assertLocalDatabase } from './env-guard.js';

describe('assertLocalDatabase', () => {
  // Test local hosts - should pass
  it('allows localhost', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@localhost:5432/db')).not.toThrow();
  });

  it('allows 127.0.0.1', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@127.0.0.1:5432/db')).not.toThrow();
  });

  it('allows [::1]', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@[::1]:5432/db')).not.toThrow();
  });

  it('allows db', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@db:5432/db')).not.toThrow();
  });

  it('allows postgres', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@postgres:5432/db')).not.toThrow();
  });

  it('allows hosts ending with .localhost', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@my.localhost:5432/db')).not.toThrow();
  });

  // Test remote hosts - should fail
  it('refuses budgetos-db.us-central1.sql.goog', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@budgetos-db.us-central1.sql.goog:5432/db')).toThrow(
      /Refusing to run against non-local database host budgetos-db\.us-central1\.sql\.goog/
    );
  });

  it('refuses 10.0.0.5', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@10.0.0.5:5432/db')).toThrow(
      /Refusing to run against non-local database host 10\.0\.0\.5/
    );
  });

  it('refuses example.com', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@example.com:5432/db')).toThrow(
      /Refusing to run against non-local database host example\.com/
    );
  });

  // Test Cloud SQL socket format (host query parameter)
  it('refuses Cloud SQL socket host parameter', () => {
    expect(() =>
      assertLocalDatabase('postgresql://u:p@localhost/db?host=/cloudsql/dmus-gonzalo:us-central1:budgetos-db')
    ).toThrow(/Refusing to run against non-local database host \/cloudsql\//);
  });

  // Test ALLOW_REMOTE_DB override
  it('allows remote with ALLOW_REMOTE_DB=1', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@example.com:5432/db', { ALLOW_REMOTE_DB: '1' })).not.toThrow();
  });

  it('refuses remote without ALLOW_REMOTE_DB', () => {
    expect(() => assertLocalDatabase('postgresql://user:pass@example.com:5432/db', {})).toThrow(
      /Refusing to run against non-local database host example\.com/
    );
  });

  // Test undefined/empty URL
  it('throws when URL is undefined', () => {
    expect(() => assertLocalDatabase(undefined)).toThrow('DATABASE_URL is not set');
  });

  it('throws when URL is empty string', () => {
    expect(() => assertLocalDatabase('')).toThrow('DATABASE_URL is not set');
  });
});
