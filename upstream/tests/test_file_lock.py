"""tests for scripts/file_lock.py"""
import json, pathlib, tempfile, os, sys
import time
import pytest

# Ensure scripts/ is importable
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'scripts'))

from file_lock import atomic_json_read, atomic_json_write, atomic_json_update
import file_lock


def test_write_and_read(tmp_path):
    p = tmp_path / 'test.json'
    data = {'hello': 'world', 'n': 42}
    atomic_json_write(p, data)
    assert p.exists()
    result = atomic_json_read(p, {})
    assert result == data


def test_read_missing_returns_default(tmp_path):
    p = tmp_path / 'nope.json'
    assert atomic_json_read(p, {'default': True}) == {'default': True}


def test_update_modifies_data(tmp_path):
    p = tmp_path / 'counter.json'
    atomic_json_write(p, {'count': 0})

    def increment(data):
        data['count'] += 1
        return data

    atomic_json_update(p, increment, {})
    assert atomic_json_read(p, {})['count'] == 1

    atomic_json_update(p, increment, {})
    assert atomic_json_read(p, {})['count'] == 2


def test_update_creates_file(tmp_path):
    p = tmp_path / 'new.json'

    def init(data):
        data['created'] = True
        return data

    atomic_json_update(p, init, {})
    assert atomic_json_read(p, {}) == {'created': True}


def test_write_atomic_no_partial(tmp_path):
    """Write should not leave partial content on disk."""
    p = tmp_path / 'atomic.json'
    big = {'items': list(range(1000))}
    atomic_json_write(p, big)
    result = json.loads(p.read_text())
    assert len(result['items']) == 1000


def test_unicode_roundtrip(tmp_path):
    p = tmp_path / 'unicode.json'
    data = {'name': '户部尚书', 'emoji': '🏛️'}
    atomic_json_write(p, data)
    result = atomic_json_read(p, {})
    assert result['name'] == '户部尚书'
    assert result['emoji'] == '🏛️'


def _old_empty_lock(tmp_path):
    path = tmp_path / 'openclaw.json.lock'
    path.touch()
    old = time.time() - file_lock._LEGACY_OPENCLAW_LOCK_MIN_AGE - 10
    os.utime(path, (old, old))
    return path


def test_openclaw_read_write_update_use_separate_python_lock(tmp_path):
    path = tmp_path / 'openclaw.json'
    assert atomic_json_read(path, {}) == {}
    atomic_json_write(path, {'count': 1})
    atomic_json_update(path, lambda data: {'count': data['count'] + 1})
    assert atomic_json_read(path) == {'count': 2}
    assert (tmp_path / 'openclaw.json.edict.lock').exists()
    assert not (tmp_path / 'openclaw.json.lock').exists()


def test_other_json_lock_path_is_unchanged(tmp_path):
    path = tmp_path / 'tasks_source.json'
    atomic_json_write(path, [])
    assert (tmp_path / 'tasks_source.json.lock').exists()
    assert not (tmp_path / 'tasks_source.json.edict.lock').exists()


@pytest.mark.skipif(os.name == 'nt', reason='Legacy POSIX flock migration only')
def test_old_unheld_empty_openclaw_lock_is_migrated(tmp_path):
    old = _old_empty_lock(tmp_path)
    assert atomic_json_read(tmp_path / 'openclaw.json', {}) == {}
    assert not old.exists()
    assert (tmp_path / 'openclaw.json.edict.lock').exists()


def test_native_json_lock_is_never_removed_even_when_old(tmp_path):
    old = _old_empty_lock(tmp_path)
    old.write_text('{"pid": 123, "createdAt": "2026-09-05"}')
    modified = time.time() - file_lock._LEGACY_OPENCLAW_LOCK_MIN_AGE - 10
    os.utime(old, (modified, modified))
    atomic_json_read(tmp_path / 'openclaw.json', {})
    assert json.loads(old.read_text())['pid'] == 123


def test_new_empty_native_lock_is_not_removed(tmp_path):
    lock = tmp_path / 'openclaw.json.lock'
    lock.touch()
    atomic_json_read(tmp_path / 'openclaw.json', {})
    assert lock.exists()


@pytest.mark.skipif(os.name == 'nt', reason='Legacy POSIX flock migration only')
def test_old_empty_lock_with_live_holder_is_not_removed(tmp_path):
    lock = _old_empty_lock(tmp_path)
    fd = os.open(str(lock), os.O_RDWR)
    try:
        file_lock._lock_exclusive(fd)
        atomic_json_read(tmp_path / 'openclaw.json', {})
        assert lock.exists()
    finally:
        file_lock._unlock(fd)
        os.close(fd)


@pytest.mark.skipif(os.name == 'nt', reason='Legacy POSIX flock migration only')
def test_replaced_inode_is_not_removed_during_legacy_migration(tmp_path, monkeypatch):
    lock = _old_empty_lock(tmp_path)
    original_flock = file_lock.fcntl.flock
    def replace_after_lock(fd, mode):
        result = original_flock(fd, mode)
        if mode == file_lock.fcntl.LOCK_EX | file_lock.fcntl.LOCK_NB:
            replacement = tmp_path / 'replacement.lock'
            replacement.write_text('{"pid": 456}')
            os.replace(replacement, lock)
        return result
    monkeypatch.setattr(file_lock.fcntl, 'flock', replace_after_lock)
    atomic_json_read(tmp_path / 'openclaw.json', {})
    assert json.loads(lock.read_text())['pid'] == 456


@pytest.mark.skipif(os.name == 'nt', reason='Symlink inspection')
def test_symlink_lock_is_not_followed_or_removed(tmp_path):
    target = tmp_path / 'other.lock'
    target.touch()
    lock = tmp_path / 'openclaw.json.lock'
    lock.symlink_to(target)
    atomic_json_read(tmp_path / 'openclaw.json', {})
    assert lock.is_symlink()
    assert target.exists()
