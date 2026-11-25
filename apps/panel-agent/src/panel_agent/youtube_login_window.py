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

    async def show(self) -> bool:
        if not self.allowed() or (handle := self.find()) is None or self.process is None:
            return False

        user = ctypes.windll.user32
        user.GetForegroundWindow.restype = wintypes.HWND
        user.ShowWindowAsync.argtypes = (wintypes.HWND, ctypes.c_int)
        user.IsIconic.argtypes = (wintypes.HWND,)
        user.BringWindowToTop.argtypes = (wintypes.HWND,)
        user.SetForegroundWindow.argtypes = (wintypes.HWND,)
        user.SetActiveWindow.argtypes = (wintypes.HWND,)
        user.SetActiveWindow.restype = wintypes.HWND
        user.GetWindowLongW.argtypes = (wintypes.HWND, ctypes.c_int)
        user.SetWindowPos.argtypes = (wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                      ctypes.c_int, ctypes.c_int, wintypes.UINT)
        user.PeekMessageW.argtypes = (ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT,
                                      wintypes.UINT, wintypes.UINT)
        if user.GetForegroundWindow() == handle:
            return True

        # Win32 restores minimized windows asynchronously. Activating before
        # restore completes can leave the kiosk in the foreground.
        if user.IsIconic(handle):
            user.ShowWindowAsync(handle, 9)  # SW_RESTORE
            for _ in range(10):
                if not user.IsIconic(handle):
                    break
                await asyncio.sleep(.04)
            if not self.allowed() or self.find() != handle or user.IsIconic(handle):
                return False
            if user.GetForegroundWindow() == handle:
                return True

        # AttachThreadInput requires the server thread to have a message queue.
        message = wintypes.MSG()
        user.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        pid = self.process.pid
        current = ctypes.windll.kernel32.GetCurrentThreadId()
        foreground = user.GetForegroundWindow()
        foreground_thread = user.GetWindowThreadProcessId(foreground, None) if foreground else 0
        target_pid = wintypes.DWORD()
        target_thread = user.GetWindowThreadProcessId(handle, ctypes.byref(target_pid))
        if target_pid.value != pid:
            return False
        attached = [
            thread for thread in {foreground_thread, target_thread} - {0, current}
            if user.AttachThreadInput(current, thread, True)
        ]
        # Chromium may sit under a fullscreen kiosk. Promote only this HWND
        # for the activation request, and restore its original stacking policy.
        topmost = bool(user.GetWindowLongW(handle, -20) & 0x8)  # GWL_EXSTYLE, WS_EX_TOPMOST
        promoted = False
        try:
            try:
                if not topmost:
                    promoted = bool(user.SetWindowPos(handle, -1, 0, 0, 0, 0, 0x43))
                user.BringWindowToTop(handle)
                user.SetActiveWindow(handle)
                user.SetForegroundWindow(handle)
            finally:
                for thread in reversed(attached):
                    user.AttachThreadInput(current, thread, False)

            for _ in range(10):
                if user.GetForegroundWindow() == handle:
                    return True
                await asyncio.sleep(.05)
            return False
        finally:
            if promoted:
                owner = user.GetWindowThreadProcessId(handle, ctypes.byref(target_pid))
                if owner and target_pid.value == pid:
                    user.SetWindowPos(handle, -2, 0, 0, 0, 0, 0x13)  # HWND_NOTOPMOST, no activate

    async def show_on_open(self) -> None:
        # A normal Edge window takes time to materialize. Make one request and
        # let Windows manage focus afterwards, including when the window closes.
        for _ in range(40):
            if not self.allowed() or self.process is None or self.process.returncode is not None:
                return
            if self.find() is not None:
                await self.show()
                return
            await asyncio.sleep(.15)
