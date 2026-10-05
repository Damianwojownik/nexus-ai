import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, GitHubConnector } from './capabilityRegistry.ts';

test('GitHub connector keeps its token in the authorization header and adapts file contents', async () => {
  const secret = 'test-token-not-for-output';
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const github = new GitHubConnector({
    token: secret,
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      if (String(input).endsWith('/user')) return Response.json({ login: 'test-user' });
      return Response.json({
        type: 'file',
        path: 'src/index.ts',
        sha: 'abc123',
        content: Buffer.from('export const ok = true;').toString('base64'),
      });
    },
  });
  const registry = new CapabilityRegistry();
  registry.register(github);

  const result = await registry.execute('github.read', { owner: 'example', repo: 'project', path: 'src/index.ts' });

  assert.equal(result.connectorId, 'github');
  assert.deepEqual(result.result, { path: 'src/index.ts', sha: 'abc123', content: 'export const ok = true;' });
  assert.ok(requests.every((request) => request.authorization === `Bearer ${secret}`));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('capability registry resolves registered connector and reports missing GitHub auth', async () => {
  const registry = new CapabilityRegistry();
  registry.register(new GitHubConnector({ token: '' }));

  const capabilities = await registry.listCapabilities();

  assert.ok(capabilities.some((capability) =>
    capability.id === 'github.search' && capability.status === 'not_configured'));
  await assert.rejects(
    registry.execute('github.search', { owner: 'example', repo: 'project', query: 'Nexus' }),
    /No connector completed github\.search/,
  );
  assert.throws(() => registry.register(new GitHubConnector({ token: '' })), /already registered/);
});

test('GitHub connector downloads release assets with a size limit and returns copyable bytes', async () => {
  const content = new Uint8Array([0, 1, 2, 255]);
  let assetRequestUrl = '';
  const github = new GitHubConnector({
    token: 'test-token',
    fetcher: async (input) => {
      assetRequestUrl = String(input);
      return new Response(content, {
        headers: {
          'content-disposition': 'attachment; filename="nexus-model.bin"',
          'content-type': 'application/octet-stream',
        },
      });
    },
  });

  const asset = await github.execute('github.asset_download', {
    owner: 'example',
    repo: 'project',
    assetId: '12345',
  }) as { filename: string; bytes: number; contentBase64: string };

  assert.equal(assetRequestUrl, 'https://api.github.com/repos/example/project/releases/assets/12345');
  assert.equal(asset.filename, 'nexus-model.bin');
  assert.equal(asset.bytes, content.byteLength);
  assert.deepEqual(Buffer.from(asset.contentBase64, 'base64'), Buffer.from(content));
  await assert.rejects(
    github.execute('github.asset_download', { owner: 'example', repo: 'project', assetId: '1/../../etc' }),
    /numeric GitHub release asset ID/,
  );
});
