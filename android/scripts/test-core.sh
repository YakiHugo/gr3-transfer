#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
# Works with a JDK or a runtime retaining the standard jdk.compiler module.
java -m jdk.compiler/com.sun.tools.javac.Main -source 17 -target 17 -Xlint:-options -d "$OUT" app/src/main/java/io/gr3/transfer/core/*.java tests/CoreTests.java tests/RecoveryTests.java tests/PreviewTests.java
java -ea -cp "$OUT" CoreTests ../fixtures
java -ea -cp "$OUT" io.gr3.transfer.core.RecoveryTests
java -ea -cp "$OUT" PreviewTests
