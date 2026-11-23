"""Scan for or exercise an owner-confirmed ELK-BLEDDM controller."""

import argparse
import asyncio
import json
import re
import sys

from bleak import BleakClient, BleakScanner

UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb"
SERVICE = "0000fff0" + UUID_SUFFIX
WRITE = "0000fff3" + UUID_SUFFIX
NOTIFY = "0000fff4" + UUID_SUFFIX
POWER = {
    "on": bytes.fromhex("7e 04 04 f0 00 01 ff 00 ef"),
    "off": bytes.fromhex("7e 04 04 00 00 00 ff 00 ef"),
}
RGB = {"red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255)}
ADDRESS = re.compile(r"(?i)(?:[a-f0-9]{2}:){5}[a-f0-9]{2}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")


class PilotError(Exception):
    pass


class DeliveryUncertain(PilotError):
    pass


async def scan(seconds: int) -> dict:
    async with asyncio.timeout(seconds + 3):
        return await BleakScanner.discover(timeout=seconds, return_adv=True)


async def operate(operation: str, address: str, seconds: int, percent: int | None = None) -> dict:
    if not ADDRESS.fullmatch(address):
        raise PilotError("A verified address is required")
    devices = await scan(seconds)
    match = next((item for device_address, item in devices.items() if device_address.lower() == address.lower()), None)
    if match is None:
        raise PilotError("Target did not advertise")
    device, info = match
    name = (info.local_name or device.name or "").strip().upper()
    if name != "ELK-BLEDDM":
        raise PilotError("Target did not advertise the expected model name")

    sent = False
    try:
        async with asyncio.timeout(17):
            async with BleakClient(device, timeout=12) as client:
                if operation == "inspect":
                    return {"name": name, "rssi": info.rssi, "services": {
                        service.uuid: {char.uuid: char.properties for char in service.characteristics}
                        for service in client.services
                    }}
                service = client.services.get_service(SERVICE)
                write = service.get_characteristic(WRITE) if service else None
                notify = service.get_characteristic(NOTIFY) if service else None
                if write is None or "write-without-response" not in write.properties or notify is None:
                    raise PilotError("Target did not match the verified GATT profile")
                data = packet(operation, percent)
                sent = True
                await client.write_gatt_char(write, data, response=False)
                await asyncio.sleep(0.35)
    except Exception as exc:
        if sent:
            raise DeliveryUncertain("Delivery uncertain. Inspect the strip before sending another command.") from exc
        raise
    return {"operation": operation, "result": "write_completed", "physical_state": "unverified"}


def packet(operation: str, percent: int | None) -> bytes:
    if operation in POWER:
        return POWER[operation]
    if operation in RGB:
        return bytes((126, 0, 5, 3, *RGB[operation], 0, 239))
    if operation == "brightness" and percent is not None and 1 <= percent <= 100:
        return bytes((126, 4, 1, percent, 255, 0, 255, 0, 239))
    raise PilotError("Unknown operation or unsupported brightness")


async def run(args: argparse.Namespace) -> dict:
    if args.command != "scan":
        return await operate(args.command, args.address, args.scan_seconds, args.percent)
    return {"devices": [
        {"address": device.address, "name": info.local_name or device.name or "", "rssi": info.rssi,
         "services": info.service_uuids, "manufacturer_ids": sorted(info.manufacturer_data)}
        for device, info in (await scan(args.scan_seconds)).values()
    ]}


def cli() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("scan", "inspect", "on", "off", *RGB, "brightness"))
    parser.add_argument("--address", help="Verified Windows BLE MAC or Mac CoreBluetooth UUID")
    parser.add_argument("--scan-seconds", type=int, default=12, choices=range(3, 31), metavar="3–30")
    parser.add_argument("--percent", type=int, choices=range(1, 101), metavar="1–100")
    args = parser.parse_args()
    if args.command != "scan" and not (args.address and ADDRESS.fullmatch(args.address)):
        parser.error("a verified --address is required for this operation")
    if args.command == "brightness" and args.percent is None:
        parser.error("brightness requires --percent")
    try:
        print(json.dumps(asyncio.run(run(args))))
    except PilotError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as exc:
        print(f"BLE operation stopped: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    cli()
