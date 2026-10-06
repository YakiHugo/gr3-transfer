#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Only a disposable hosted runner may create this synthetic-test emulator.
if [[ ${GITHUB_ACTIONS:-} != true || ${GR3_DISPOSABLE_CI:-} != true ]]; then
  echo 'This runner is only for disposable GitHub Actions CI. Use test-emulator.sh with an explicitly authorized emulator locally.' >&2
  exit 2
fi
sdk=${ANDROID_HOME:?The hosted runner must provide its official Android SDK}
export PATH="$sdk/platform-tools:$sdk/emulator:$sdk/cmdline-tools/latest/bin:$PATH"
mkdir -p build/native-smoke
export ANDROID_AVD_HOME
ANDROID_AVD_HOME=$(mktemp -d)
emulator_pid=
cleanup() {
  adb -s emulator-5554 logcat -d > build/native-smoke/logcat.txt 2>&1 || true
  adb -s emulator-5554 exec-out run-as io.gr3.transfer tar -cf - files/smoke-screenshots > build/native-smoke/screenshots.tar 2>/dev/null || true
  if adb -s emulator-5554 shell run-as io.gr3.transfer test -f files/dialog-failure.txt 2>/dev/null; then
    adb -s emulator-5554 exec-out run-as io.gr3.transfer cat files/dialog-failure.txt > build/native-smoke/dialog-failure.txt 2>/dev/null || true
  fi
  if [[ -n $emulator_pid ]]; then kill "$emulator_pid" 2>/dev/null || true; wait "$emulator_pid" 2>/dev/null || true; fi
  rm -rf "$ANDROID_AVD_HOME"
}
trap cleanup EXIT
if adb devices | grep -q '^emulator-5554'; then echo 'Refusing to reuse an existing emulator' >&2; exit 2; fi
# Licenses are preaccepted by the runner. Never automatically accept new terms.
sdkmanager 'emulator' 'system-images;android-29;default;x86_64' </dev/null
[[ -f "$sdk/system-images/android-29/default/x86_64/system.img" ]]
printf 'no\n' | avdmanager create avd --force --name gr3-ci --package 'system-images;android-29;default;x86_64'
cat >> "$ANDROID_AVD_HOME/gr3-ci.avd/config.ini" <<'AVD'
hw.lcd.width=320
hw.lcd.height=640
hw.lcd.density=160
hw.ramSize=1536
hw.cpu.ncore=2
vm.heapSize=256
hw.keyboard=yes
AVD
# Use acceleration only when this runner already grants access and the official
# probe confirms it is usable. Never change device/group/security permissions.
acceleration=off
if [[ -r /dev/kvm && -w /dev/kvm ]]; then
  if emulator -accel-check > build/native-smoke/acceleration-check.txt 2>&1; then acceleration=on; fi
else
  printf 'KVM is not already readable and writable; using software fallback.\n' > build/native-smoke/acceleration-check.txt
fi
printf 'Emulator acceleration: %s; two virtual CPUs; no host permission changes.\n' "$acceleration" | tee build/native-smoke/acceleration-mode.txt
emulator -avd gr3-ci -port 5554 -no-window -no-audio -no-boot-anim -no-snapshot -cores 2 -accel "$acceleration" -gpu swiftshader_indirect -camera-back none -camera-front none > build/native-smoke/emulator.txt 2>&1 &
emulator_pid=$!
deadline=$((SECONDS + 900))
while [[ $(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') != 1 ]]; do
  if ! kill -0 "$emulator_pid" 2>/dev/null || (( SECONDS >= deadline )); then echo 'Disposable emulator did not boot' >&2; exit 1; fi
  sleep 5
done
adb -s emulator-5554 shell input keyevent 82
adb -s emulator-5554 shell settings put global window_animation_scale 0
adb -s emulator-5554 shell settings put global transition_animation_scale 0
adb -s emulator-5554 shell settings put global animator_duration_scale 0
# Let system services settle after first boot before strict UI assertions.
sleep 20
./scripts/test-emulator.sh emulator-5554
