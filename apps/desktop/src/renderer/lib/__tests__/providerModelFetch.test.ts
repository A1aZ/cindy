import { describe, expect, it } from 'vitest';

import { providerModelFetchRequestSignature } from '../providerModelFetch';

const fields = {
  baseUrl: ' https://api.example/v1 ',
  requestPath: ' /responses ',
  modelsUrl: ' /models ',
  apiKey: ' secret-a ',
  headers: [
    { name: 'Authorization', value: 'Bearer stale' },
    { name: 'X-Tenant', value: 'acme' },
  ],
};

describe('providerModelFetchRequestSignature', () => {
  it('invalidates an in-flight result when the auth mode changes', () => {
    expect(providerModelFetchRequestSignature(fields, 'apiKey')).not.toBe(
      providerModelFetchRequestSignature(fields, 'oauth'),
    );
    expect(providerModelFetchRequestSignature(fields, 'oauth')).not.toBe(
      providerModelFetchRequestSignature(fields, 'none'),
    );
  });

  it('tracks only the API key that is effective for the selected auth mode', () => {
    const changed = { ...fields, apiKey: 'secret-b' };
    expect(providerModelFetchRequestSignature(fields, 'apiKey')).not.toBe(
      providerModelFetchRequestSignature(changed, 'apiKey'),
    );
    expect(providerModelFetchRequestSignature(fields, 'oauth')).toBe(
      providerModelFetchRequestSignature(changed, 'oauth'),
    );
  });

  it('uses credential-stripped headers for no-auth requests', () => {
    const changedCredential = {
      ...fields,
      headers: [
        { name: 'Authorization', value: 'Bearer changed' },
        { name: 'X-Tenant', value: 'acme' },
      ],
    };
    const changedEffectiveHeader = {
      ...fields,
      headers: [
        { name: 'Authorization', value: 'Bearer stale' },
        { name: 'X-Tenant', value: 'other' },
      ],
    };
    expect(providerModelFetchRequestSignature(fields, 'none')).toBe(
      providerModelFetchRequestSignature(changedCredential, 'none'),
    );
    expect(providerModelFetchRequestSignature(fields, 'none')).not.toBe(
      providerModelFetchRequestSignature(changedEffectiveHeader, 'none'),
    );
  });
});
