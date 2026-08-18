"""
LinkCore Python SDK Test
Requires: linkcore start in another terminal
"""

import sys
sys.path.insert(0, ".")

from linkcore import LinkCore

passed = 0
failed = 0


def assert_test(condition, name):
    global passed, failed
    if condition:
        passed += 1
        print("  OK " + name)
    else:
        failed += 1
        print("  FAIL " + name)


lc = LinkCore(timeout=60)

print("LinkCore Python SDK Tests")
print("")

# Test 1: health
print("=== Test 1: health ===")
health = lc.health()
assert_test(health["ok"] is True, "health returns ok")
assert_test(health["service"] == "linkcore-core-service", "health returns service")
print("  -> Service: " + str(health.get("service")) + " v" + str(health.get("version")))

# Test 2: status
print("")
print("=== Test 2: status ===")
status = lc.status()
assert_test(status["service"] == "linkcore-core-service", "status returns service")
assert_test("ollama" in status, "status returns ollama")
ollama = status.get("ollama", {})
print("  -> Catalog: " + str(ollama.get("catalogo", 0)) + " models")

# Test 3: chip
print("")
print("=== Test 3: chip ===")
chip = lc.chip()
assert_test("health" in chip, "chip returns health")
assert_test("learning" in chip, "chip returns learning")
learning = chip.get("learning", {})
print("  -> Total queries: " + str(learning.get("totalQueries", 0)))

# Test 4: ask
print("")
print("=== Test 4: ask ===")
result = lc.ask("responde solo: hola mundo")
assert_test(len(result["text"]) > 0, "ask returns text")
assert_test(result["model"] is not None, "ask returns model")
assert_test(result["provider"] is not None, "ask returns provider")
assert_test(result["latency_ms"] > 0, "ask returns latency")
print("  -> Text: '" + result["text"][:80] + "...'")
print("  -> Model: " + str(result["model"]))
print("  -> Latency: " + str(result["latency_ms"]) + "ms")

# Test 5: cache
print("")
print("=== Test 5: ask (cache) ===")
result2 = lc.ask("responde solo: hola mundo")
assert_test(len(result2["text"]) > 0, "cached ask returns text")
print("  -> Latency: " + str(result2["latency_ms"]) + "ms")

print("")
print("=" * 40)
print("Results: " + str(passed) + " passed, " + str(failed) + " failed")
if failed > 0:
    sys.exit(1)
