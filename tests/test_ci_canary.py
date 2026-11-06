"""Canary test: proves the CI suite reports a failing test."""

import unittest


class CiCanaryTest(unittest.TestCase):
    def test_deliberate_failure(self):
        self.fail("deliberate failure to prove CI catches it")


if __name__ == "__main__":
    unittest.main()
