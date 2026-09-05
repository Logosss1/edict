"""
文件锁工具 — 防止多进程并发读写 JSON 文件导致数据丢失。

用法:
    from file_lock import atomic_json_update, atomic_json_read

    # 原子读取
    data = atomic_json_read(path, default=[])

    # 原子更新（读 → 修改 → 写回，全程持锁）
    def modifier(tasks):
        tasks.append(new_task)
        return tasks 
    atomic_json_update(path, modifier, default=[])
"""
import json
import os
import pathlib
import stat
import tempfile
import time
from typing import Any, Callable

_IS_WINDOWS = os.name == 'nt'
_LEGACY_OPENCLAW_LOCK_MIN_AGE = 60

if _IS_WINDOWS:
    import msvcrt
else:
    import fcntl


# ── 平台抽象：文件锁 ────────────────────────────────────────────

def _lock_shared(fd: int) -> None:
    """获取共享锁（读锁）。"""
    if _IS_WINDOWS:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_SH)


def _lock_exclusive(fd: int) -> None:
    """获取排他锁（写锁）。"""
    if _IS_WINDOWS:
        msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX)


def _unlock(fd: int) -> None:
    """释放锁。"""
    if _IS_WINDOWS:
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)


def _migrate_empty_openclaw_lock(lock_file: pathlib.Path) -> None:
    """Remove only an old, unheld Python flock file, never a native JSON lock."""
    if _IS_WINDOWS:
        return
    fd, locked = None, False
    try:
        before = lock_file.lstat()
        if (not stat.S_ISREG(before.st_mode) or before.st_size or before.st_nlink != 1
                or time.time() - before.st_mtime < _LEGACY_OPENCLAW_LOCK_MIN_AGE):
            return
        fd = os.open(str(lock_file), os.O_RDWR | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            return
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locked = True
        current = lock_file.lstat()
        held = os.fstat(fd)
        if ((current.st_dev, current.st_ino) == (held.st_dev, held.st_ino) == (before.st_dev, before.st_ino)
                and stat.S_ISREG(current.st_mode) and current.st_nlink == held.st_nlink == 1
                and current.st_size == held.st_size == 0
                and time.time() - max(current.st_mtime, held.st_mtime) >= _LEGACY_OPENCLAW_LOCK_MIN_AGE):
            lock_file.unlink()
    except OSError:
        pass
    finally:
        if fd is not None:
            if locked:
                _unlock(fd)
            os.close(fd)


def _lock_path(path: pathlib.Path) -> pathlib.Path:
    if path.name == 'openclaw.json':
        _migrate_empty_openclaw_lock(path.parent / (path.name + '.lock'))
        # This serializes Python callers only, not native OpenClaw transactions.
        return path.parent / (path.name + '.edict.lock')
    return path.parent / (path.name + '.lock')


def atomic_json_read(path: pathlib.Path, default: Any = None) -> Any:
    """持锁读取 JSON 文件。"""
    lock_file = _lock_path(path)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR)
    try:
        _lock_shared(fd)
        try:
            return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
        except Exception:
            return default
    finally:
        _unlock(fd)
        os.close(fd)


def atomic_json_update(
    path: pathlib.Path,
    modifier: Callable[[Any], Any],
    default: Any = None,
) -> Any:
    """
    原子地读取 → 修改 → 写回 JSON 文件。
    modifier(data) 应返回修改后的数据。
    使用临时文件 + rename 保证写入原子性。
    """
    lock_file = _lock_path(path)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR)
    try:
        _lock_exclusive(fd)
        # Read
        try:
            data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
        except Exception:
            data = default
        # Modify
        result = modifier(data)
        # Atomic write via temp file + rename
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), suffix='.tmp', prefix=path.stem + '_'
        )
        try:
            with os.fdopen(tmp_fd, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, str(path))
        except Exception:
            os.unlink(tmp_path)
            raise
        return result
    finally:
        _unlock(fd)
        os.close(fd)


def atomic_json_write(path: pathlib.Path, data: Any) -> None:
    """原子写入 JSON 文件（持排他锁 + tmpfile rename）。
    直接写入，不读取现有内容（避免 atomic_json_update 的多余读开销）。
    """
    lock_file = _lock_path(path)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR)
    try:
        _lock_exclusive(fd)
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), suffix='.tmp', prefix=path.stem + '_'
        )
        try:
            with os.fdopen(tmp_fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, str(path))
        except Exception:
            os.unlink(tmp_path)
            raise
    finally:
        _unlock(fd)
        os.close(fd)
