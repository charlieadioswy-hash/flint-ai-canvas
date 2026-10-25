#!/usr/bin/env python3
"""Build and deploy this development installation from one persistent checkout."""
import argparse
import concurrent.futures
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

SOURCE = Path('/home/dev/flint-ai-canvas')
STATE = Path('/home/dev/.flint-deploy')
BACKUPS = Path('/home/dev/flint-backups')
APPS = ('backend', 'web', 'yingce-agent')
SERVICES = (*APPS, 'postgres', 'redis')
FIELDS = ('version', 'commit', 'builtAt', 'baseCommit', 'worktreeDigest', 'archiveSha256')
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
RUN = STATE


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    Path(path).chmod(0o600)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def mark(stage, **details):
    value = dict(stage=stage, time=now(), **details)
    write(STATE / 'status.json', value)
    print(json.dumps(value, ensure_ascii=False), flush=True)


def run(args, *, data=None, output=None):
    with (Path(output).open('wb') if output else open(os.devnull, 'wb')) as stream:
        result = subprocess.run(args, input=data, stdout=stream if output else subprocess.PIPE,
                                stderr=subprocess.PIPE)
    if result.returncode:
        (STATE / 'last-command.stderr').write_bytes(result.stderr)
        raise RuntimeError(f'{args[0]} failed ({result.returncode}); see {STATE}/last-command.stderr')
    return result.stdout if not output else b''


def docker(*args, **kwargs):
    return run(DOCKER + list(args), **kwargs)


def query(sql, database=''):
    return docker('exec', '-i', 'flint-ai-canvas-postgres-1', 'sh', '-c',
                  'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}" -At',
                  'sh', database, data=sql.encode()).decode().strip()


def container(name):
    return json.loads(docker('inspect', 'flint-ai-canvas-' + name + '-1'))[0]


def services():
    result = {}
    for name in SERVICES:
        row = container(name)
        result[name] = dict(id=row['Id'], image=row['Image'], startedAt=row['State']['StartedAt'],
                            running=row['State']['Running'], restartCount=row['RestartCount'],
                            health=row['State'].get('Health', {}).get('Status'),
                            mounts=sorted([{k: m.get(k) for k in ('Type', 'Name', 'Source', 'Destination', 'RW')}
                                           for m in row['Mounts']], key=lambda m: m['Destination']))
    return result


def compose(*args, override=None):
    command = DOCKER + ['compose', '-p', 'flint-ai-canvas', '--project-directory', str(SOURCE),
                        '--env-file', str(SOURCE / '.env'), '-f', str(SOURCE / 'docker-compose.deploy.yml'),
                        '-f', str(STATE / 'preserved-runtime.json')]
    if override:
        command += ['-f', str(override)]
    return command + list(args)


def safe_path(value):
    path = PurePosixPath(value)
    require(not path.is_absolute() and path.parts and all(p not in ('.', '..') for p in path.parts), 'Unsafe source path')
    require(path.parts[0] not in ('.git', '.env', '.local', 'data', 'node_modules', '.flint-deploy'), 'Reserved source path')
    target = SOURCE.joinpath(*path.parts)
    require(target.parent.resolve().is_relative_to(SOURCE.resolve()), 'Source parent escapes checkout')
    return target


def install_source():
    settings, manifest = read(STATE / 'settings.json'), read(STATE / 'manifest.json')
    payload = {'baseCommit': manifest['baseCommit'], 'files': manifest['files']}
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    require(manifest['baseCommit'] == settings['baseCommit'] and
            digest == manifest['worktreeDigest'] == settings['worktreeDigest'], 'Source identity differs from manifest')
    archive = STATE / 'incoming.tar.gz'
    require(sha(archive) == settings['archiveSha256'], 'Source archive checksum mismatch')
    entries = {entry['path']: entry for entry in manifest['files']}
    require(len(entries) == len(manifest['files']), 'Duplicate manifest paths')
    # Validate every member before touching the fixed checkout. Runtime files are
    # excluded from the manifest and never removed by source synchronization.
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        files = [m for m in members if not m.isdir()]
        require(len(files) == len(entries) and {m.name for m in files} == entries.keys(), 'Archive manifest differs')
        for member in members:
            safe_path(member.name)
            require(member.isdir() or member.isfile() or member.issym(), 'Unsupported archive entry')
            if member.issym():
                require(not Path(member.linkname).is_absolute() and
                        (safe_path(member.name).parent / member.linkname).resolve().is_relative_to(SOURCE.resolve()), 'Unsafe symlink')
        for member in files:
            entry = entries[member.name]
            content = member.linkname.encode() if member.issym() else bundle.extractfile(member).read()
            require(hashlib.sha256(content).hexdigest() == entry['sha256'], 'Archive file checksum mismatch')
        previous = read(STATE / 'installed-manifest.json') if (STATE / 'installed-manifest.json').exists() else {'files': []}
        for old in previous['files']:
            if old['path'] not in entries:
                path = safe_path(old['path'])
                if path.is_file() or path.is_symlink():
                    path.unlink()
                    parent = path.parent
                    while parent != SOURCE:
                        try:
                            parent.rmdir()
                        except OSError:
                            break
                        parent = parent.parent
        for member in files:
            path = safe_path(member.name)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            if path.is_symlink():
                path.unlink()
            require(not path.is_dir(), 'Source file conflicts with existing directory')
            if member.issym():
                path.symlink_to(member.linkname)
            else:
                with path.open('wb') as stream:
                    shutil.copyfileobj(bundle.extractfile(member), stream)
                path.chmod(0o755 if entry_mode(entries[member.name]) & 0o111 else 0o644)
        for path in SOURCE.rglob('*'):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o755)
    write(STATE / 'installed-manifest.json', manifest)
    verify_source()
    mark('source-installed', directory=str(SOURCE), files=len(entries))


def entry_mode(entry):
    return int(entry.get('mode', 0o755 if entry.get('executable') else 0o644))


def verify_source():
    for entry in read(STATE / 'installed-manifest.json')['files']:
        path = safe_path(entry['path'])
        digest = hashlib.sha256(os.readlink(path).encode()).hexdigest() if path.is_symlink() else sha(path)
        require(digest == entry['sha256'], 'Installed source differs: ' + entry['path'])


def idle():
    count = query("SELECT (SELECT count(*) FROM tasks WHERE status IN ('queued','running') OR (status='text_replay' AND updated_at > now() - interval '30 minutes')) + (SELECT count(*) FROM cloud_agent_executions WHERE status NOT IN ('completed','failed','cancelled','rejected') OR cleanup_pending=true) + (SELECT count(*) FROM image_moderation_checks WHERE active_key IS NOT NULL);")
    require(count == '0', 'Active generation work exists; retry after tasks complete')
    health = json.loads(docker('exec', 'flint-ai-canvas-yingce-agent-1', 'wget', '-qO-', 'http://127.0.0.1:8081/healthz'))
    require(health['ok'] and health['active'] == 0 and health['queued'] == 0, 'Agent has active work')


def snapshot(name, database='', reference=None):
    args = ['python3', str(SOURCE / 'scripts/development-verify-data.py'), 'snapshot', '--output', str(RUN / name)]
    if database:
        args += ['--database', database]
    if reference:
        args += ['--reference', str(RUN / reference)]
    run(args)


def compare(before, after):
    run(['python3', str(SOURCE / 'scripts/development-verify-data.py'), 'compare', str(RUN / before), str(RUN / after)],
        output=RUN / (after + '.comparison.log'))


def backup_db(name):
    target = RUN / name
    docker('exec', 'flint-ai-canvas-postgres-1', 'sh', '-c',
           'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc', output=target)
    listing = docker('exec', '-i', 'flint-ai-canvas-postgres-1', 'pg_restore', '--list', data=target.read_bytes())
    require(b'TABLE DATA' in listing, 'Invalid database archive')
    return sha(target)


def data_root(service, destination):
    return Path(next(m['Source'] for m in read(RUN / 'baseline.json')['services'][service]['mounts'] if m['Destination'] == destination))


def resources():
    rows = json.loads(query("SELECT coalesce(json_agg(json_build_object('key',object_key,'size',size)),'[]') FROM resources WHERE provider='local' AND status='ready';"))
    base = data_root('backend', '/data') / 'resources'
    digest, size = hashlib.sha256(), 0
    for row in sorted(rows, key=lambda r: r['key']):
        path = (base / row['key']).resolve()
        require(path.is_relative_to(base.resolve()) and path.is_file() and path.stat().st_size == row['size'], 'Resource missing or changed')
        digest.update(row['key'].encode())
        digest.update(bytes.fromhex(sha(path)))
        size += row['size']
    return dict(count=len(rows), bytes=size, sha256=digest.hexdigest())


def preserve_infrastructure():
    current, before = services(), read(RUN / 'baseline.json')['services']
    for name in ('postgres', 'redis'):
        require(all(current[name][key] == before[name][key] for key in ('id', 'image', 'startedAt', 'restartCount', 'mounts')), 'Infrastructure changed: ' + name)
        require(current[name]['health'] == 'healthy', 'Infrastructure unhealthy: ' + name)
    require(sha(SOURCE / '.env') == read(RUN / 'baseline.json')['envSHA256'], 'Environment configuration changed')


def build():
    settings = read(STATE / 'settings.json')
    release = {key: settings[key] for key in FIELDS}
    generated = SOURCE / 'web/public/release.json'
    generated.write_text(json.dumps(release) + '\n')
    generated.chmod(0o644)
    args = dict(BUILD_VERSION=settings['version'], BUILD_COMMIT=settings['commit'], BUILD_TIME=settings['builtAt'])
    if settings.get('goproxy'):
        args['GOPROXY'] = settings['goproxy']
    args['VITE_TLDRAW_LICENSE_KEY'] = '${VITE_TLDRAW_LICENSE_KEY:-}'
    labels = {'cn.yingce.build.' + key: value for key, value in release.items()}
    builds = {}
    for name in APPS:
        builds[name] = dict(image='open-ai-canvas-' + name + ':dev', build=dict(context=str(SOURCE),
                            dockerfile='Dockerfile' if name == 'web' else name + '/Dockerfile', args=args,
                            labels=labels, network='host'))
    write(STATE / 'build.json', dict(services=builds))
    for name in APPS:
        mark('building-' + name)
        with (RUN / (name + '-build.log')).open('wb') as stream:
            result = subprocess.run(compose('--progress', 'plain', 'build', '--builder', 'default', name,
                                            override=STATE / 'build.json'), stdout=stream, stderr=subprocess.STDOUT)
        require(result.returncode == 0, name + ' build failed; see ' + str(RUN / (name + '-build.log')))
    identities = {}
    for name in APPS:
        image = 'open-ai-canvas-' + name + ':dev'
        row = json.loads(docker('image', 'inspect', image))[0]
        require(all(row['Config']['Labels'].get('cn.yingce.build.' + key) == value for key, value in release.items()), 'Build identity differs')
        identities[name] = dict(image=image, id=row['Id'])
    write(RUN / 'images.json', identities)
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'sh', identities['web']['id'], '-c',
           'cd /opt/canvas-release && find . -type f -exec sha256sum {} +', output=RUN / 'web.sha256')
    verify_source()


def migration(action, database=None):
    override = None
    if database:
        config = json.loads(run(compose('config', '--format', 'json')))
        parts = urllib.parse.urlsplit(config['services']['migrate']['environment']['DATABASE_URL'])
        write(STATE / 'clone.json', {'services': {'migrate': {'environment': {'DATABASE_URL':
              urllib.parse.urlunsplit(parts._replace(path='/' + database))}}}})
        override = STATE / 'clone.json'
    run(compose('run', '--rm', '--no-deps', 'migrate', action, override=override),
        output=RUN / (('clone-' if database else 'schema-') + action + '.log'))


def rehearse():
    clone = 'flint_development_rehearsal'
    exists = query("SELECT count(*) FROM pg_database WHERE datname='" + clone + "';")
    require(exists == '0', 'Previous rehearsal database exists; investigate before retry')
    docker('exec', 'flint-ai-canvas-postgres-1', 'sh', '-c', 'exec createdb -U "$POSTGRES_USER" "$1"', 'sh', clone)
    try:
        docker('exec', '-i', 'flint-ai-canvas-postgres-1', 'sh', '-c',
               'exec pg_restore --exit-on-error -U "$POSTGRES_USER" -d "$1"', 'sh', clone,
               data=(RUN / 'database.initial.dump').read_bytes())
        snapshot('clone.before.json', clone)
        for action in ('up', 'up', 'verify'):
            migration(action, clone)
        snapshot('clone.after.json', clone, reference='clone.before.json')
        compare('clone.before.json', 'clone.after.json')
        mark('migration-rehearsed')
    finally:
        docker('exec', 'flint-ai-canvas-postgres-1', 'sh', '-c', 'exec dropdb -U "$POSTGRES_USER" "$1"', 'sh', clone)
        (STATE / 'clone.json').unlink(missing_ok=True)


def verify_http(base='http://127.0.0.1:3000/'):
    settings = read(STATE / 'settings.json')
    def fetch(path):
        with urllib.request.urlopen(base + path, timeout=30) as response:
            return response.read()
    ready = json.loads(fetch('api/health/ready'))
    require(ready['code'] == 0 and ready['data']['ready'] and all(ready['data']['checks'].values()), 'Readiness failed')
    schema = ready['data']['schema']
    require(schema['ready'] and schema['current'] == schema['expected'], 'Schema mismatch')
    version = json.loads(fetch('api/system/version'))['data']['build']
    require(version['commit'] == settings['commit'] and version['version'] == settings['version'] and version['buildTime'] == settings['builtAt'], 'Backend build mismatch')
    release = json.loads(fetch('release.json'))
    require(all(release[key] == settings[key] for key in FIELDS), 'Web build mismatch')
    manifest = {name.removeprefix('./'): digest for digest, name in
                (line.split(None, 1) for line in (RUN / 'web.sha256').read_text().splitlines())}
    def check(item):
        name, digest = item
        require(hashlib.sha256(fetch(name)).hexdigest() == digest, 'Static file differs: ' + name)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(check, manifest.items()))
        old = read(RUN / 'web-protected.json')
        list(pool.map(check, ((name, digest) for name, digest in old.items() if name not in manifest)))
    for path in ('', 'canvas', 'screen-creation', 'model3d-creation', 'assets', 'login'):
        require(hashlib.sha256(fetch(path)).hexdigest() == manifest['index.html'], 'SPA route differs')
    for path in ('api/canvas-projects?page=1&pageSize=10', 'api/resources'):
        try:
            fetch(path)
            raise RuntimeError('Unauthenticated private endpoint accepted')
        except urllib.error.HTTPError as error:
            require(error.code == 401, 'Unexpected authentication status')
    return dict(schema=schema['current'], staticFiles=len(manifest), protectedPreviousAssets=len(old), commit=settings['commit'])


def verify_plugins():
    before = {row['id']: row for row in read(RUN / 'plugin_registry.before.json')}
    rows = json.loads(docker('exec', 'flint-ai-canvas-backend-1', 'cat', '/data/plugin_registry.json'))
    after = {row['id']: row for row in rows}
    require(before.keys() <= after.keys(), 'Existing plugin disappeared')
    for name, row in before.items():
        require(row['manifest'].get('enabled') == after[name]['manifest'].get('enabled'), 'Plugin enabled state changed')
        require(all(row.get(key) == after[name].get(key) for key in ('source', 'installedAt')), 'Plugin identity changed')
    for row in rows:
        if row.get('packagePath'):
            package = docker('exec', 'flint-ai-canvas-backend-1', 'cat', '/data/plugin-packages/' + row['packagePath'])
            require(hashlib.sha256(package).hexdigest() == row['packageSha256'], 'Installed plugin digest differs')
    return dict(existingPreserved=len(before), additions=sorted(after.keys() - before.keys()))


def cold_backup():
    baseline = read(RUN / 'baseline.json')
    baseline['resources'] = resources()
    baseline['settingsKeySHA256'] = sha(data_root('backend', '/data') / '.settings-key')
    write(RUN / 'baseline.json', baseline)
    shutil.copy2(data_root('backend', '/data') / 'plugin_registry.json', RUN / 'plugin_registry.before.json')
    snapshot('business.before.json')
    checksums = {'database.final.dump': backup_db('database.final.dump')}
    for service, destination, filename in (('backend', '/data', 'backend-data.tar.gz'), ('web', '/usr/share/nginx/html', 'web-data.tar.gz')):
        docker('run', '--rm', '--network', 'none', '--user', 'root', '--volumes-from', 'flint-ai-canvas-' + service + '-1:ro',
               '--entrypoint', 'sh', baseline['services'][service]['image'], '-c', 'tar -czf - -C "$1" .', 'sh', destination, output=RUN / filename)
        run(['gzip', '-t', str(RUN / filename)])
        checksums[filename] = sha(RUN / filename)
    write(RUN / 'final-checksums.json', checksums)


def verify_privately():
    name = 'flint-development-web-check'
    networks = list(container('backend')['NetworkSettings']['Networks'])
    require(len(networks) == 1, 'Expected one application network for private verification')
    image = read(RUN / 'images.json')['web']['id']
    docker('run', '-d', '--name', name, '--network', networks[0], '-p', '127.0.0.1::3000',
           '--volumes-from', 'flint-ai-canvas-web-1', image)
    try:
        for _ in range(120):
            row = json.loads(docker('inspect', name))[0]
            if row['State'].get('Health', {}).get('Status') == 'healthy':
                break
            require(row['State']['Running'], 'Private verification web stopped')
            time.sleep(1)
        else:
            raise RuntimeError('Private verification web did not become healthy')
        port = row['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
        return verify_http('http://127.0.0.1:' + port + '/')
    finally:
        docker('rm', '-f', name)


def rollback():
    before = read(RUN / 'baseline.json')
    require((RUN / 'final-checksums.json').exists(), 'No complete cold backup; apps can be restarted without migration')
    for name, digest in read(RUN / 'final-checksums.json').items():
        require(sha(RUN / name) == digest, 'Rollback checksum mismatch')
    mark('rollback-stopping-apps')
    run(compose('stop', *APPS))
    backup_db('database.failed-state.dump')
    docker('exec', '-i', 'flint-ai-canvas-postgres-1', 'sh', '-c',
           'exec pg_restore --clean --if-exists --create --exit-on-error -U "$POSTGRES_USER" -d postgres',
           data=(RUN / 'database.final.dump').read_bytes())
    for service, destination, filename in (('backend', '/data', 'backend-data.tar.gz'), ('web', '/usr/share/nginx/html', 'web-data.tar.gz')):
        docker('run', '--rm', '-i', '--network', 'none', '--user', 'root', '--volumes-from', 'flint-ai-canvas-' + service + '-1',
               '--entrypoint', 'sh', before['services'][service]['image'], '-c', 'exec tar -xzf - -C "$1"', 'sh', destination,
               data=(RUN / filename).read_bytes())
    snapshot('rollback.json')
    original, restored = read(RUN / 'business.before.json'), read(RUN / 'rollback.json')
    require(all(original[key] == restored[key] for key in ('tables', 'columns', 'ledgerRows')), 'Restored database differs')
    override = RUN / 'rollback-runtime.json'
    for name in ('yingce-agent', 'backend', 'web'):
        run(compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', name, override=override))
        docker('tag', before['services'][name]['image'], 'open-ai-canvas-' + name + ':dev')
    preserve_infrastructure()
    mark('rolled-back', backup=str(RUN))


def deploy():
    global RUN
    settings = read(STATE / 'settings.json')
    verify_source()
    require((SOURCE / '.env').is_file() and (STATE / 'preserved-runtime.json').is_file(), 'Installed runtime configuration required')
    require(shutil.disk_usage(SOURCE).free > 6 * 1024**3, 'Need 6GiB free for builds and cold backups')
    current = services()
    require(all(row['running'] and row['health'] == 'healthy' for row in current.values()), 'Starting services must be healthy')
    config = json.loads(run(compose('config', '--format', 'json')))
    for name in SERVICES:
        live = dict(value.split('=', 1) for value in container(name)['Config']['Env'])
        require(all(str(value) == live.get(key) for key, value in config['services'][name].get('environment', {}).items()), 'Runtime environment differs: ' + name)
        configured = {(v['target'], v['type'], config['volumes'][v['source']]['name'] if v['type'] == 'volume' else v['source']) for v in config['services'][name].get('volumes', [])}
        mounted = {(v['Destination'], v['Type'], v['Name'] if v['Type'] == 'volume' else v['Source']) for v in current[name]['mounts']}
        require(configured == mounted, 'Runtime mounts differ: ' + name)
    idle()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    RUN = BACKUPS / stamp
    RUN.mkdir(mode=0o700)
    write(STATE / 'latest.json', dict(backup=str(RUN)))
    for source, name in ((SOURCE / '.env', '.env'), (STATE / 'preserved-runtime.json', 'preserved-runtime.json'),
                         (STATE / 'settings.json', 'settings.json'), (STATE / 'installed-manifest.json', 'manifest.json'),
                         (SOURCE / 'docker-compose.deploy.yml', 'docker-compose.deploy.yml')):
        shutil.copy2(source, RUN / name)
    baseline = dict(services=current, envSHA256=sha(SOURCE / '.env'))
    write(RUN / 'baseline.json', baseline)
    webroot = data_root('web', '/usr/share/nginx/html')
    protected = set()
    for name in ('.canvas-assets-current',):
        if (webroot / name).exists():
            protected.update((webroot / name).read_text().splitlines())
    write(RUN / 'web-protected.json', {name: sha(webroot / name) for name in sorted(protected)})
    write(RUN / 'rollback-runtime.json', {'services': {name: {'image': current['backend' if name == 'migrate' else name]['image']} for name in (*APPS, 'migrate')}})
    for name in APPS:
        docker('tag', current[name]['image'], 'open-ai-canvas-' + name + ':previous')
    mark('initial-backup', backup=str(RUN))
    backup_db('database.initial.dump')
    build()
    rehearse()
    preserve_infrastructure()
    idle()
    stopped, migrated, public_started = False, False, False
    try:
        mark('stopping-idle-apps')
        stopped = True
        run(compose('stop', *APPS))
        mark('cold-backup')
        cold_backup()
        baseline = read(RUN / 'baseline.json')
        mark('migrating')
        migrated = True
        migration('up')
        migration('verify')
        snapshot('business.migrated.json', reference='business.before.json')
        compare('business.before.json', 'business.migrated.json')
        require(resources() == baseline['resources'], 'Resource bytes changed during migration')
        for name in ('yingce-agent', 'backend'):
            mark('starting-' + name)
            run(compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', name))
        preserve_infrastructure()
        for name, image in read(RUN / 'images.json').items():
            if name == 'web':
                continue
            actual = services()[name]
            require(actual['image'] == image['id'] and actual['health'] == 'healthy' and actual['mounts'] == current[name]['mounts'], 'Application identity/mounts differ')
        require(sha(data_root('backend', '/data') / '.settings-key') == baseline['settingsKeySHA256'], 'Settings key changed')
        require(resources() == baseline['resources'], 'Resource bytes changed after startup')
        mark('verifying-on-loopback')
        http, plugins = verify_privately(), verify_plugins()
        snapshot('business.after.json', reference='business.before.json')
        frozen, live = read(RUN / 'business.migrated.json'), read(RUN / 'business.after.json')
        for table in ('canvas_projects', 'assets', 'resources', 'tasks', 'model_channels', 'channel_models', 'model_pricings', 'model3d_configs', 'image_moderation_configs', 'image_moderation_policies', 'image_moderation_providers'):
            require(frozen['tables'].get(table) == live['tables'].get(table), 'Protected table changed on startup: ' + table)
        # Reopen the public entry only after validation. Once new requests may
        # write data, never automatically replace their database with a backup.
        mark('publishing-web')
        public_started = True
        run(compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'web'))
        write(RUN / 'receipt.json', dict(identity={k: settings[k] for k in FIELDS}, http=http, plugins=plugins,
                                       resources=baseline['resources'], completedAt=now(), services=services()))
        write(STATE / 'deployment-receipt.json', read(RUN / 'receipt.json'))
        (SOURCE / '.deployment-commit').write_text(settings['commit'] + '\n')
        mark('deployed', backup=str(RUN), **http)
    except Exception:
        if public_started:
            mark('requires-attention', reason='Public entry reopening started; preserve new writes and inspect before restoring a backup')
        elif migrated:
            rollback()
        elif stopped:
            for name in ('yingce-agent', 'backend', 'web'):
                docker('start', 'flint-ai-canvas-' + name + '-1')
        raise


def main():
    global RUN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-source', action='store_true')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Use sudo -n via /home/dev/deploy-flint-dev.sh')
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    os.umask(0o077)
    STATE.mkdir(exist_ok=True, mode=0o700)
    BACKUPS.mkdir(exist_ok=True, mode=0o700)
    with (STATE / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.install_source:
            install_source()
        elif args.verify or args.rollback:
            RUN = Path(read(STATE / 'latest.json')['backup'])
            require(RUN.parent == BACKUPS and RUN.is_dir(), 'Invalid backup directory')
            rollback() if args.rollback else print(json.dumps(verify_http()))
        else:
            deploy()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        mark('failed', error=str(error))
        raise SystemExit(1)
