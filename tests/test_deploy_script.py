"""Exercise release switching and rollback using fake Docker/curl commands."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'deploy.sh'
BASH = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash')


def shell_path(path):
    value = Path(path).absolute().as_posix()
    return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value


@unittest.skipUnless(BASH and Path(BASH).is_file(), 'Bash is required for deployment checks')
class DeployScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.old = self.root / 'releases' / ('a' * 40)
        self.new = self.root / 'releases' / ('b' * 40)
        for folder in [self.old, self.new]:
            folder.mkdir(parents=True)
            (folder / 'compose.yml').write_text('test configuration', encoding='utf-8')
            shutil.copyfile(SCRIPT, folder / 'deploy.sh')
        self.old_image = 'ghcr.io/example/backend:' + 'a' * 40
        self.new_image = 'ghcr.io/example/backend:' + 'b' * 40
        (self.old / '.image').write_text(self.old_image + '\n', encoding='utf-8')
        (self.root / '.env').write_text('GEMINI_API_KEY=test\n', encoding='utf-8')
        self.env = {**os.environ, 'TEXTLENS_ROOT': shell_path(self.root),
                    'MOCK_LOG': shell_path(self.root / 'commands'),
                    'TEST_PYTHON': str(Path(os.sys.executable).resolve())}
        if os.name == 'nt':
            self.env['MSYS'] = 'winsymlinks:nativestrict'
        link = self.command('ln -s ' + shlex.quote(shell_path(self.old)) + ' ' + shlex.quote(shell_path(self.root / 'current')))
        if link.returncode != 0:
            if os.name == 'nt':
                self.skipTest('Windows native symlink permission is unavailable; these checks run on Linux CI')
            self.fail(link.stderr)
        self.fake('flock', 'exit 0\n')
        self.fake('docker', '''
while [[ $1 != -f ]]; do shift; done
shift
file=$1
shift
printf '%s|%s|%s\\n' "$TEXTLENS_IMAGE" "$file" "$*" >> "$MOCK_LOG"
case "$1" in
  config) exit 0 ;;
  pull) [[ ${MOCK_FAILURE:-} != pull ]]; exit $? ;;
  up)
    if [[ ${MOCK_FAILURE:-} == startup && $TEXTLENS_IMAGE == *:bbbb* ]]; then exit 1; fi
    exit 0 ;;
  down) exit 0 ;;
  exec)
    shift 2
    if [[ $2 == printenv ]]; then echo example.test; exit 0; fi
    shift 2
    exec "$TEST_PYTHON" "$@" ;;
esac
exit 1
''')
        self.fake('curl', '''
if [[ ${MOCK_FAILURE:-} == https ]]; then exit 22; fi
revision=${TEXTLENS_IMAGE##*:}
if [[ ${MOCK_FAILURE:-} == wrong_revision ]]; then revision=wrong; fi
printf '{"status":"ok","service":"textlens-handwriting","version":"%s","gemini":{"configured":true},"requires_access_token":false}\\n' "$revision"
''')

    def fake(self, name, body):
        path = self.bin / name
        path.write_text('#!/usr/bin/env bash\nset -eu\n' + body, encoding='utf-8', newline='\n')
        path.chmod(0o755)

    def command(self, command, env=None):
        return subprocess.run([BASH, '-c', command], env=env or self.env, text=True,
                              capture_output=True, timeout=20)

    def deploy(self, failure=''):
        env = {**self.env, 'MOCK_FAILURE': failure}
        command = 'export PATH=' + shlex.quote(shell_path(self.bin)) + ':"$PATH"; bash ' + shlex.quote(shell_path(self.new / 'deploy.sh')) + ' ' + shlex.quote(self.new_image)
        return self.command(command, env)

    def current(self):
        return self.command('readlink -f ' + shlex.quote(shell_path(self.root / 'current'))).stdout.strip()

    def test_success_promotes_verified_release(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.current(), shell_path(self.new))
        self.assertEqual((self.new / '.image').read_text().strip(), self.new_image)

    def test_failed_pull_keeps_running_release(self):
        result = self.deploy('pull')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current(), shell_path(self.old))
        self.assertNotIn('|up ', (self.root / 'commands').read_text())

    def test_startup_https_and_revision_failures_restore_previous_image(self):
        for failure in ['startup', 'https', 'wrong_revision']:
            with self.subTest(failure=failure):
                result = self.deploy(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.current(), shell_path(self.old))
                commands = (self.root / 'commands').read_text()
                self.assertIn(self.old_image + '|' + shell_path(self.old / 'compose.yml') + '|up -d --wait', commands)

    def test_failed_first_deploy_stops_stack_without_deleting_certificate_volumes(self):
        self.command('unlink ' + shlex.quote(shell_path(self.root / 'current')))
        result = self.deploy('startup')
        self.assertNotEqual(result.returncode, 0)
        commands = (self.root / 'commands').read_text()
        self.assertIn('|down\n', commands)
        self.assertNotIn('down -v', commands)
