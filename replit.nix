{pkgs}: {
  deps = [
    pkgs.xorg.libxshmfence
    pkgs.libGLU
    pkgs.libGL
    pkgs.libgbm
    pkgs.libxkbcommon
    pkgs.glib
    pkgs.alsa-lib
    pkgs.mesa
    pkgs.libdrm
    pkgs.expat
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.xorg.libxcb
    pkgs.chromium
  ];
}
