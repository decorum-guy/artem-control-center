import ctypes
import sys

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field


class BatteryStatus(BaseModel):
    percentage: int | None = Field(ge=0, le=100)
    charging: bool | None
    pluggedIn: bool | None


class SystemPowerStatus(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_ubyte),
        ("BatteryFlag", ctypes.c_ubyte),
        ("BatteryLifePercent", ctypes.c_ubyte),
        ("SystemStatusFlag", ctypes.c_ubyte),
        ("BatteryLifeTime", ctypes.c_uint32),
        ("BatteryFullLifeTime", ctypes.c_uint32),
    ]


def decode_battery(status: SystemPowerStatus) -> BatteryStatus | None:
    flags = status.BatteryFlag
    percentage = status.BatteryLifePercent if status.BatteryLifePercent <= 100 else None
    if (flags != 255 and flags & 128) or (flags == 255 and percentage is None):
        return None
    return BatteryStatus(
        percentage=percentage,
        charging=None if flags == 255 else bool(flags & 8),
        pluggedIn={0: False, 1: True}.get(status.ACLineStatus),
    )


def read_battery() -> BatteryStatus | None:
    if sys.platform != "win32":
        return None
    status = SystemPowerStatus()
    if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):
        return None
    return decode_battery(status)


router = APIRouter(prefix="/api/v1/system")


@router.get("/battery")
def battery_status(response: Response) -> BatteryStatus | None:
    response.headers["Cache-Control"] = "no-store"
    return read_battery()
