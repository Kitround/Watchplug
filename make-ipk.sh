#!/bin/sh
# Builds luci-app-watchplug_<version>_all.ipk without the OpenWrt SDK.
# This package is pure shell + JS, so there is nothing to cross-compile.
#
# Format note: an OpenWrt 21.02 .ipk is a *gzipped tar* holding ./debian-binary,
# ./data.tar.gz and ./control.tar.gz -- not the Debian-style `ar` archive. opkg
# rejects an ar container with "pkg_init_from_file: Malformed package file".
# Everything below mirrors what the OpenWrt buildroot itself emits: GNU tar
# format, ./-prefixed paths, uid/gid 0.
set -e

PKG=luci-app-watchplug
here=$(cd "$(dirname "$0")" && pwd)

# The release number is the commit count, so every commit ships a version opkg
# sees as newer, and rebuilding the same commit gives the same version. Both are
# overridable: the CI sets VERSION from the tag.
VERSION=${VERSION:-1.0.0}
RELEASE=${RELEASE:-$(git -C "$here" rev-list --count HEAD 2>/dev/null || echo 1)}
build=$here/build
ipk=$here/${PKG}_${VERSION}-${RELEASE}_all.ipk

# GNU tar and bsdtar (macOS) spell root ownership and the GNU format differently.
if tar --version 2>&1 | grep -qi 'gnu tar'; then
	TAROPTS="--owner=0 --group=0 --numeric-owner --format=gnu"
else
	TAROPTS="--uid 0 --gid 0 --uname root --gname root --no-xattrs --no-mac-metadata --format=gnutar"
fi
export COPYFILE_DISABLE=1

# Sweep every previous artifact, not just the one about to be written: the release
# number is the commit count, so each build lands under a new name and the old ones
# pile up. A stale .ipk sitting next to a fresh one is how the wrong version gets
# flashed -- and an .ipk built from a dirty tree carries a number that lies.
rm -rf "$build"
rm -f "$here"/${PKG}_*_all.ipk
mkdir -p "$build/data" "$build/control"

cp -R "$here/package/files/." "$build/data/"
find "$build/data" -type d -exec chmod 0755 {} +
find "$build/data" -type f -exec chmod 0644 {} +
chmod 0755 "$build/data/usr/sbin/watchplug" \
	"$build/data/etc/init.d/watchplug" \
	"$build/data/usr/libexec/rpcd/luci.watchplug"

( cd "$build/data" && tar $TAROPTS -czf ../data.tar.gz . )

cp -R "$here/package/control/." "$build/control/"
chmod 0644 "$build/control/control" "$build/control/conffiles"
chmod 0755 "$build/control/postinst" "$build/control/prerm"
# Installed-Size is the size on the target, not the size of the compressed payload.
sed -i.bak -e "s/@VERSION@/${VERSION}-${RELEASE}/" \
	-e "s/@SIZE@/$(find "$build/data" -type f -exec cat {} + | wc -c | tr -d ' ')/" \
	"$build/control/control"
rm -f "$build/control/control.bak"

( cd "$build/control" && tar $TAROPTS -czf ../control.tar.gz . )

echo 2.0 >"$build/debian-binary"
( cd "$build" && tar $TAROPTS -czf "$ipk" ./debian-binary ./data.tar.gz ./control.tar.gz )

# Cheap guard against regressing the container format again.
tar tzf "$ipk" | tr -d '\r' | sort >"$build/members"
printf './control.tar.gz\n./data.tar.gz\n./debian-binary\n' >"$build/members.expected"
cmp -s "$build/members" "$build/members.expected" || {
	echo "ERROR: unexpected members in $ipk" >&2
	cat "$build/members" >&2
	exit 1
}

rm -rf "$build"
echo "$ipk"
