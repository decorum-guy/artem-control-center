from __future__ import annotations

import argparse
import getpass

from .access_policy import AccessPolicyStore


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure the local Control Center access PIN")
    parser.add_argument(
        "--profile",
        choices=("read_only", "standard", "full"),
        default="standard",
    )
    args = parser.parse_args()

    first = getpass.getpass("New Control Center PIN (4-12 digits): ")
    second = getpass.getpass("Repeat PIN: ")
    if first != second:
        raise SystemExit("PIN values do not match")

    store = AccessPolicyStore.from_environment()
    store.set_pin(first)
    store.set_profile(args.profile, pin=first if args.profile == "full" else None)
    print(f"Control Center PIN configured. Base profile: {args.profile}.")
    print(f"Policy file: {store.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
