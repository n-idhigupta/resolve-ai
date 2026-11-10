import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const images = [
  [
    'clamav/clamav',
    'stable',
    'sha256:2a9be29239aea6c6fe17da9625f3c192f91974e61059d364e293f20277f931a3',
  ],
];
for (const [repo, tag, digest] of images) {
  console.log('Downloading ' + repo + ':' + tag);
  const dir = '.local/oci-' + repo.replace('/', '-');
  mkdirSync(dir + '/blobs/sha256', { recursive: true });
  const auth = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
  ).then((r) => r.json());
  const headers = {
    Authorization: 'Bearer ' + auth.token,
    Accept:
      'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
  };
  const get = async (path) => {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(
          `https://registry-1.docker.io/v2/${repo}/${path}`,
          { headers, signal: AbortSignal.timeout(180000) },
        );
        if (!r.ok) throw Error(`${r.status}: ${path}`);
        return Buffer.from(await r.arrayBuffer());
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  const index = JSON.parse(await get('manifests/' + digest));
  const descriptor = index.manifests?.find(
    (m) => m.platform.os === 'linux' && m.platform.architecture === 'amd64',
  ) ?? {
    digest,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    size: Buffer.byteLength(JSON.stringify(index)),
    platform: { os: 'linux', architecture: 'amd64' },
  };
  const manifestBytes = await get('manifests/' + descriptor.digest);
  const { createHash: manifestHash } = await import('node:crypto');
  if (
    'sha256:' + manifestHash('sha256').update(manifestBytes).digest('hex') !==
    descriptor.digest
  )
    throw Error('Manifest checksum mismatch');
  descriptor.size = manifestBytes.length;
  const manifest = JSON.parse(manifestBytes);
  writeFileSync(
    dir + '/blobs/' + descriptor.digest.replace(':', '/'),
    manifestBytes,
  );
  for (const blob of [manifest.config, ...manifest.layers]) {
    const path = dir + '/blobs/' + blob.digest.replace(':', '/');
    if (!existsSync(path)) {
      const bytes = await get('blobs/' + blob.digest);
      const { createHash } = await import('node:crypto');
      if (
        createHash('sha256').update(bytes).digest('hex') !==
        blob.digest.split(':')[1]
      )
        throw Error('Image checksum mismatch');
      writeFileSync(path, bytes);
    }
  }
  const reference =
    (repo.startsWith('library/') ? repo.slice(8) : repo) + ':' + tag;
  writeFileSync(
    dir + '/oci-layout',
    JSON.stringify({ imageLayoutVersion: '1.0.0' }),
  );
  writeFileSync(
    dir + '/index.json',
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          ...descriptor,
          annotations: {
            'io.containerd.image.name':
              'docker.io/' + repo + '@' + descriptor.digest,
            'org.opencontainers.image.ref.name':
              'docker.io/' + repo + '@' + descriptor.digest,
          },
        },
      ],
    }),
  );
  const archive = dir + '.tar';
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', [
    '-cf',
    archive,
    '-C',
    dir,
    'oci-layout',
    'index.json',
    'blobs',
  ]);
  execFileSync('docker', ['load', '-i', archive], { stdio: 'inherit' });
  console.log('Loaded verified ' + reference);
}
