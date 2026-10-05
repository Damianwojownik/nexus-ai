import unittest

import numpy as np

from scene_layers import compose_scene_frame


class SceneLayerTests(unittest.TestCase):
    def setUp(self):
        self.actor = np.full((8, 8, 3), 200, dtype=np.uint8)
        self.background = np.full((8, 8, 3), 20, dtype=np.uint8)
        self.mask = np.zeros((8, 8), dtype=np.uint8)
        self.mask[:4] = 255

    def test_background_changes_without_changing_character(self):
        first = compose_scene_frame(self.actor, self.background, self.mask)
        second = compose_scene_frame(self.actor, self.background + 30, self.mask)
        np.testing.assert_array_equal(first[:4], self.actor[:4])
        np.testing.assert_array_equal(second[:4], first[:4])
        np.testing.assert_array_equal(second[4:], self.background[4:] + 30)

    def test_character_moves_without_changing_background(self):
        first = compose_scene_frame(self.actor, self.background, self.mask)
        second = compose_scene_frame(self.actor + 10, self.background, self.mask)
        np.testing.assert_array_equal(first[4:], second[4:])
        np.testing.assert_array_equal(second[:4], self.actor[:4] + 10)

    def test_soft_matte_edges(self):
        self.mask[:] = 128
        result = compose_scene_frame(self.actor, self.background, self.mask)
        self.assertTrue(np.all(result == 110))

    def test_rejects_mismatched_layers_and_rgb_matte(self):
        for actor, scene, mask in [
            (self.actor, self.background[:4], self.mask),
            (self.actor, self.background, self.mask[:4]),
            (self.actor, self.background, self.actor),
            (self.actor.astype(float), self.background, self.mask),
        ]:
            with self.subTest(shape=mask.shape), self.assertRaises(ValueError):
                compose_scene_frame(actor, scene, mask)


if __name__ == "__main__":
    unittest.main()
