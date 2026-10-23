#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sync_dir="$HOME/Library/Application Support/Servo7 WeChat Sync"
reader_app="$sync_dir/WeChat Brain Reader.app"
umask 077
mkdir -p "$reader_app/Contents/MacOS"
chmod 700 "$sync_dir"
/usr/bin/swiftc -O "$source_dir/reader.swift" -o "$reader_app/Contents/MacOS/wechat-reader.new"
mv "$reader_app/Contents/MacOS/wechat-reader.new" "$reader_app/Contents/MacOS/wechat-reader"
cp "$source_dir/Reader-Info.plist" "$reader_app/Contents/Info.plist"
/usr/bin/codesign --force --sign - --identifier com.servo7.wechat-brain.reader "$reader_app"
cp "$source_dir/sync.py" "$sync_dir/sync.py"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/wechat-brain" <<'SH'
#!/bin/sh
exec /usr/bin/python3 "$HOME/Library/Application Support/Servo7 WeChat Sync/sync.py" "$@"
SH
chmod 700 "$HOME/.local/bin/wechat-brain"
printf 'Installed: %s\n' "$HOME/.local/bin/wechat-brain"
"$HOME/.local/bin/wechat-brain" doctor
