#!/bin/bash
NOTE="eyJ2ZXJzaW9uIjoxLCJwb29sIjoiQm9DVG9yRTdkRHlGVGFLNG9DRXc4SzN3N0Y2RnhyS0NTcWJBR1Z2NGN4WEwiLCJzZWNyZXQiOiIxOTI5NzU2Mzk4NTExOTQ3NDQ1NDcyMjcyNDk0MzAyNjM3ODg4ODU4NTkzOTE2MjQ5OTg1MDM5MDQwODI4NDMxNTE0MDU4ODU1Mjc0MSIsIm51bGxpZmllcl9wcmVpbWFnZSI6IjUyMjI1ODQ2OTI0MzIxOTg1OTMwMzYzNDcyMjkxOTEwNjQ3NDM2MTY4MTA3MDIwMzk1NTUzNzY4NDQ2NjA2OTA5MDA1ODUzODY3NzkiLCJkZXBvc2l0X2Vwb2NoIjoiNjE3NzAiLCJ0b2tlbl9taW50IjoiMCIsImNvbW1pdG1lbnQiOiIzOTE5OTc4MTY2Mzc3Njc1OTU1NTIwNzU4NzQzNzU4MTkwOTEwMjUxNjYzOTc3NTU5NTM0MTgxMzUwNDkyNzIxNzg3ODc5NDU2MjU1IiwibGVhZkluZGV4IjoyLCJ0b2tlbiI6IlNPTCIsImRlbm9taW5hdGlvbkh1bWFuIjoxfQ=="

echo "=== Waiting for note maturity (target: epoch 61773, ~10:13) ==="
while true; do
  echo ""
  echo "[$(date +%H:%M:%S)] Attempting unshield..."
  node scripts/unshield-note.mjs "$NOTE" 2>&1
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    # exit code 0 means either success OR "not mature yet" (we changed it to exit 0)
    # Check if the output contains "SUCCESS"
    RESULT=$(node scripts/unshield-note.mjs "$NOTE" 2>&1)
    echo "$RESULT"
    if echo "$RESULT" | grep -q "SUCCESS"; then
      echo ""
      echo "=== UNSHIELD COMPLETE ==="
      break
    fi
  fi
  if [ $EXIT_CODE -eq 1 ]; then
    echo "Error occurred, retrying in 5 minutes..."
  fi
  echo "Sleeping 5 minutes..."
  sleep 300
done
