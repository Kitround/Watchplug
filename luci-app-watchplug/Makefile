#
# Copyright (C) 2026 Kitround
#
# This is free software, licensed under the Apache License, Version 2.0.
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Watchplug - power-cycle an HTTP-controlled device from interface connectivity
LUCI_DESCRIPTION:=Pings out of a monitored interface's own device, so a failover route cannot \
	hide an outage, and power-cycles an HTTP-controlled device once the link has stayed down \
	long enough. Built-in Tasmota preset or free-form HTTP URLs.
LUCI_DEPENDS:=+luci-base +jshn
LUCI_PKGARCH:=all

# luci.mk fills the package's MAINTAINER and URL fields from LUCI_MAINTAINER and
# LUCI_URL, not from PKG_MAINTAINER -- left unset, the package would ship claiming
# the LuCI community maintains it and link to openwrt/luci. PKG_MAINTAINER is set
# too because the packaging guidelines ask for it.
LUCI_MAINTAINER:=Kitround <github@krnd.fr>
LUCI_URL:=https://github.com/Kitround/luci-app-watchplug

PKG_VERSION:=1.3.1
PKG_RELEASE:=1
PKG_MAINTAINER:=Kitround <github@krnd.fr>
PKG_LICENSE:=Apache-2.0

# All three blocks must precede luci.mk: it calls BuildPackage at the end of its own
# parse, and it only supplies a default postinst when the package has not defined one.
#
# Keeping /etc/config/watchplug across upgrades is why secs() still accepts a bare
# number -- an older release wrote values this one would otherwise read as 0.
define Package/luci-app-watchplug/conffiles
/etc/config/watchplug
endef

# The first three lines are luci.mk's own default, which defining this block replaces:
# the menu and ACL are cached, and rpcd has to be told about the new ubus object.
# Starting the daemon unconditionally is safe -- it idles until "enabled" is set.
define Package/luci-app-watchplug/postinst
[ -n "$${IPKG_INSTROOT}" ] || { \
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
	/etc/init.d/watchplug enable 2>/dev/null
	/etc/init.d/watchplug restart 2>/dev/null
	exit 0
}
endef

define Package/luci-app-watchplug/prerm
[ -n "$${IPKG_INSTROOT}" ] || { \
	/etc/init.d/watchplug stop 2>/dev/null
	/etc/init.d/watchplug disable 2>/dev/null
	rm -f /tmp/luci-indexcache.*
	exit 0
}
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
