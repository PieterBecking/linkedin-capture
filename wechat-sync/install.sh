#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sync_dir="$HOME/Library/Application Support/Servo7 WeChat Sync"
reader_app="$sync_dir/WeChat Brain Reader.app"
umask 077
mkdir -p "$reader_app/Contents/MacOS"
chmod 700 "$sync_dir"
reader_digest=$(cat "$source_dir/reader.swift" "$source_dir/Reader-Info.plist" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
installed_digest=$(cat "$sync_dir/.reader-source.sha256" 2>/dev/null || true)
if [ "$reader_digest" != "$installed_digest" ] || ! /usr/bin/codesign --verify --strict "$reader_app" 2>/dev/null; then
    /usr/bin/swiftc -O "$source_dir/reader.swift" -o "$reader_app/Contents/MacOS/wechat-reader.new"
    mv "$reader_app/Contents/MacOS/wechat-reader.new" "$reader_app/Contents/MacOS/wechat-reader"
    cp "$source_dir/Reader-Info.plist" "$reader_app/Contents/Info.plist"
    /usr/bin/codesign --force --sign - --identifier com.servo7.wechat-brain.reader "$reader_app"
    printf '%s\n' "$reader_digest" > "$sync_dir/.reader-source.sha256"
fi
cp "$source_dir/sync.py" "$sync_dir/sync.py"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/wechat-brain" <<'SH'
#!/bin/sh
exec /usr/bin/python3 "$HOME/Library/Application Support/Servo7 WeChat Sync/sync.py" "$@"
SH
chmod 700 "$HOME/.local/bin/wechat-brain"
printf 'Installed: %s\n' "$HOME/.local/bin/wechat-brain"
"$HOME/.local/bin/wechat-brain" doctor
