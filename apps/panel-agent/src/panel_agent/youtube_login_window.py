"""Foreground requests for the dedicated, interactive YouTube Edge process."""

from __future__ import annotations

import asyncio
import ctypes
import sys
from collections.abc import Callable
from ctypes import wintypes


class YouTubeLoginWindow:
    def __init__(self, allowed: Callable[[], bool]) -> None:
        self.allowed = allowed
        self.process: asyncio.subprocess.Process | None = None

    def find(self) -> int | None:
        process = self.process
        if sys.platform != "win32" or process is None or process.returncode is not None:
            return None

        user = ctypes.windll.user32
        user.GetWindow.argtypes = (wintypes.HWND, wintypes.UINT)
        user.GetWindow.restype = wintypes.HWND
        user.IsWindowVisible.argtypes = (wintypes.HWND,)
        user.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
        user.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user.EnumWindows.argtypes = (callback_type, wintypes.LPARAM)
        window = None

        @callback_type
        def visit(handle, _parameter):
            nonlocal window
            pid = wintypes.DWORD()
            user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
            if pid.value != process.pid or not user.IsWindowVisible(handle) or user.GetWindow(handle, 4):  # GW_OWNER
                return True
            class_name = ctypes.create_unicode_buffer(64)
            user.GetClassNameW(handle, class_name, len(class_name))
            if class_name.value != "Chrome_WidgetWin_1":
                return True
            window = handle
            return False

        user.EnumWindows(visit, 0)
        return window

    def show(self) -> bool:
        if not self.allowed() or (handle := self.find()) is None:
            return False

        user = ctypes.windll.user32
        user.GetForegroundWindow.restype = wintypes.HWND
        user.ShowWindowAsync.argtypes = (wintypes.HWND, ctypes.c_int)
        user.IsIconic.argtypes = (wintypes.HWND,)
        user.BringWindowToTop.argtypes = (wintypes.HWND,)
        user.SetForegroundWindow.argtypes = (wintypes.HWND,)
        if user.GetForegroundWindow() == handle:
            return True

        current = ctypes.windll.kernel32.GetCurrentThreadId()
        foreground = user.GetForegroundWindow()
        foreground_thread = user.GetWindowThreadProcessId(foreground, None) if foreground else 0
        target_pid = wintypes.DWORD()
        target_thread = user.GetWindowThreadProcessId(handle, ctypes.byref(target_pid))
        if self.process is None or target_pid.value != self.process.pid:
            return False
        attached = [
            thread for thread in {foreground_thread, target_thread} - {0, current}
            if user.AttachThreadInput(current, thread, True)
        ]
        try:
            if user.IsIconic(handle):
                user.ShowWindowAsync(handle, 9)  # SW_RESTORE
            user.BringWindowToTop(handle)
            user.SetForegroundWindow(handle)
            return user.GetForegroundWindow() == handle
        finally:
            for thread in reversed(attached):
                user.AttachThreadInput(current, thread, False)

    async def show_on_open(self) -> None:
        # A normal Edge window takes time to materialize. Make one request and
        # let Windows manage focus afterwards, including when the window closes.
        for _ in range(40):
            if not self.allowed() or self.process is None or self.process.returncode is not None:
                return
            if self.find() is not None:
                self.show()
                return
            await asyncio.sleep(.15)
