#!/usr/bin/env bash
# Freeze this worktree and publish it through the fixed development entry point.
set -Eeuo pipefail
umask 077

development_host=dev@192.168.100.11
repository_path="$(dirname "${BASH_SOURCE[0]}")/.."
allow_other_host=false
runner_arguments=()
while (($#)); do
  case "$1" in
    --host) development_host="${2:?--host requires a destination}"; shift 2 ;;
    --repo) repository_path="${2:?--repo requires a directory}"; shift 2 ;;
    --allow-other-host) allow_other_host=true; shift ;;
    -h|--help)
      printf 'Usage: %s [--repo PATH] [--host USER@HOST --allow-other-host] [-- RUNNER_ARGS...]\n' "$0"
      exit 0 ;;
    --) shift; runner_arguments=("$@"); break ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$development_host" =~ ^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$ ]] || {
  printf 'Expected an SSH destination in USER@HOST form.\n' >&2; exit 2;
}
if [[ "$development_host" != dev@192.168.100.11 && "$allow_other_host" != true ]]; then
  printf 'A custom development host requires --allow-other-host.\n' >&2
  exit 2
fi
for executable in git python3 ssh tar; do command -v "$executable" >/dev/null; done
repository_path="$(git -C "$repository_path" rev-parse --show-toplevel)"
publish_bundle="$repository_path/.local/cache/development-publish"
mkdir -p "$publish_bundle"
publish_lock="$publish_bundle/.publish-lock"
mkdir "$publish_lock" || { printf 'A local development publish is already active.\n' >&2; exit 1; }
trap 'rmdir "$publish_lock" 2>/dev/null || true' EXIT

python3 - "$repository_path" "$publish_bundle" <<'PY'
import datetime
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile

repo, bundle = map(Path, sys.argv[1:])
if bundle.is_symlink():
    raise SystemExit('The publish cache must not be a symlink')
repo, bundle = repo.resolve(), bundle.resolve()

def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args])

def private(name):
    parts = PurePosixPath(name).parts
    return (any(part in {'.git', '.local', '.cache', 'node_modules', '__pycache__'} for part in parts)
            or any(part.startswith('.env') and part != '.env.example' for part in parts)
            or parts[-1] in {'.settings-key', 'id_rsa', 'id_ed25519', 'credentials.json'}
            or parts[-1].lower().endswith(('.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx')))

base = git('rev-parse', 'HEAD').decode().strip()
status_before = git('status', '--porcelain=v1', '-z', '--untracked-files=all')
names = sorted(set(os.fsdecode(name) for name in git('ls-files', '-c', '-o', '--exclude-standard', '-z').split(b'\0') if name))
archive_path = bundle / 'source.tar.gz'
temporary_archive = bundle / 'source.tar.gz.tmp'
files, directories, helpers, frozen_stats = [], set(), {}, {}
with temporary_archive.open('wb') as output:
    with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT,
                          pax_headers={'comment': base}) as archive:
            for name in names:
                relative = PurePosixPath(name)
                if relative.is_absolute() or '..' in relative.parts or str(relative) != name:
                    raise SystemExit('Unsafe source path')
                if private(name):
                    continue
                path = repo / name
                if not path.parent.resolve().is_relative_to(repo):
                    raise SystemExit('A source parent escapes the repository: ' + name)
                try:
                    before = path.lstat()
                except FileNotFoundError:
                    continue  # Deleted tracked files are absent from the snapshot.
                if stat.S_ISLNK(before.st_mode):
                    target = os.readlink(path)
                    if os.path.isabs(target) or not (path.parent / target).resolve().is_relative_to(repo):
                        raise SystemExit('A source symlink escapes the repository: ' + name)
                    content, mode, kind = target.encode(), 0o777, 'symlink'
                elif stat.S_ISREG(before.st_mode):
                    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                    with os.fdopen(descriptor, 'rb') as source:
                        if os.fstat(source.fileno()).st_ino != before.st_ino:
                            raise SystemExit('Source changed before reading: ' + name)
                        content = source.read()
                    mode, kind = (0o755 if before.st_mode & 0o111 else 0o644), 'file'
                else:
                    raise SystemExit('Unsupported source file type: ' + name)
                after = path.lstat()
                if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_mode) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode):
                    raise SystemExit('Source changed while freezing: ' + name)
                frozen_stats[name] = (after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode)
                item = dict(path=name, kind=kind, mode=mode, size=len(content), sha256=hashlib.sha256(content).hexdigest())
                if kind == 'symlink':
                    item['target'] = target
                for parent in reversed(relative.parents):
                    parent_name = str(parent)
                    if parent_name == '.' or parent_name in directories:
                        continue
                    directory = tarfile.TarInfo(parent_name)
                    directory.type, directory.mode = tarfile.DIRTYPE, 0o755
                    archive.addfile(directory)
                    directories.add(parent_name)
                member = tarfile.TarInfo(name)
                member.mode = mode
                if kind == 'symlink':
                    member.type, member.linkname = tarfile.SYMTYPE, target
                    archive.addfile(member)
                else:
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
                files.append(item)
                if name in ('scripts/development-release.py', 'scripts/deploy-development.sh', 'VERSION'):
                    helpers[name] = content
for name in ('scripts/development-release.py', 'scripts/deploy-development.sh', 'VERSION'):
    if name not in helpers:
        raise SystemExit('Required deployment input is missing: ' + name)
if git('rev-parse', 'HEAD').decode().strip() != base or git('status', '--porcelain=v1', '-z', '--untracked-files=all') != status_before:
    raise SystemExit('Worktree changed while freezing; publish again')
for name, expected in frozen_stats.items():
    current = (repo / name).lstat()
    if (current.st_ino, current.st_size, current.st_mtime_ns, current.st_mode) != expected:
        raise SystemExit('Source changed after archiving: ' + name)
payload = dict(baseCommit=base, files=files)
digest = hashlib.sha256(json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
archive_digest = hashlib.sha256()
with temporary_archive.open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        archive_digest.update(block)
settings = dict(version=helpers['VERSION'].decode().strip(), commit=base[:8] + ('-dirty.' + digest[:12] if status_before else ''),
                builtAt=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                baseCommit=base, worktreeDigest=digest, archiveSha256=archive_digest.hexdigest(), snapshotKind='worktree')
if shutil.which('go'):
    environment = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOPROXY', 'GOPATH'], cwd=repo))
    settings.update(goproxy=environment['GOPROXY'], gopath=environment['GOPATH'])
else:
    settings.update({key.lower(): os.environ[key] for key in ('GOPROXY', 'GOPATH') if key in os.environ})
for filename, value in (('manifest.json', dict(payload, worktreeDigest=digest)), ('settings.json', settings)):
    (bundle / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
for filename, content in (('runner.py', helpers['scripts/development-release.py']), ('deploy-flint-dev.sh', helpers['scripts/deploy-development.sh'])):
    (bundle / filename).write_bytes(content)
temporary_archive.replace(archive_path)
print(json.dumps(dict(commit=settings['commit'], files=len(files), archiveBytes=archive_path.stat().st_size, worktreeDigest=digest)))
PY

# Keep upload, source installation, and deployment under one server-side lock.
remote_script=$(cat <<'SH'
set -eu
umask 077
state=/home/dev/.flint-deploy
upload=/home/dev/.flint-publish
mkdir -p "$upload"
tar -xf - -C "$upload"
install -m 0600 "$upload/settings.json" "$state/settings.json"
install -m 0600 "$upload/manifest.json" "$state/manifest.json"
install -m 0700 "$upload/runner.py" "$state/runner.py"
install -m 0755 "$upload/deploy-flint-dev.sh" /home/dev/deploy-flint-dev.sh
mv "$upload/source.tar.gz" "$state/incoming.tar.gz"
python3 "$state/runner.py" --install-source
exec python3 "$state/runner.py" "$@"
SH
)
remote_command=$(python3 - "$remote_script" ${runner_arguments[@]+"${runner_arguments[@]}"} <<'PY'
import shlex
import sys
print('sudo -n install -d -m 0700 /home/dev/.flint-deploy && sudo -n flock /home/dev/.flint-deploy/publish.lock sh -c '
      + shlex.quote(sys.argv[1]) + ' publish-development ' + ' '.join(map(shlex.quote, sys.argv[2:])))
PY
)
tar -C "$publish_bundle" -cf - source.tar.gz settings.json manifest.json runner.py deploy-flint-dev.sh \
  | ssh -o BatchMode=yes -o ConnectTimeout=15 "$development_host" "$remote_command"
