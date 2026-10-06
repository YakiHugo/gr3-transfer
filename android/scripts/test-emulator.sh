#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
serial=${1:-}
if [[ ! "$serial" =~ ^emulator-[0-9]+$ ]]; then
  echo 'Usage: scripts/test-emulator.sh emulator-5554 (a booted, disposable emulator only)' >&2
  exit 2
fi
if [[ $(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r') != 1 ]]; then
  echo 'The selected emulator has not completed booting' >&2; exit 1
fi
mkdir -p build/native-smoke
adb -s "$serial" install -t -r app/build/outputs/apk/debug/app-debug.apk
adb -s "$serial" install -t -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
run_phase() {
  local phase=$1
  adb -s "$serial" shell am instrument -w -r -e phase "$phase" io.gr3.transfer.test/io.gr3.transfer.NativeSmokeInstrumentation | tee "build/native-smoke/$phase.txt"
  grep -q '^INSTRUMENTATION_RESULT: stream=PASS ' "build/native-smoke/$phase.txt"
  ! grep -q 'FAIL\|INSTRUMENTATION_FAILED' "build/native-smoke/$phase.txt"
}
run_phase smoke
adb -s "$serial" shell am force-stop io.gr3.transfer
run_phase tools
adb -s "$serial" shell am force-stop io.gr3.transfer
run_phase layout
run_phase prepare-death
adb -s "$serial" shell am force-stop io.gr3.transfer
run_phase verify-death
adb -s "$serial" shell am force-stop io.gr3.transfer
run_phase verify-death-cleared
printf 'Native smoke and process-restart tests passed on %s\n' "$serial"
