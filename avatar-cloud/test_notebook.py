import ast
import json
from pathlib import Path
import unittest
from unittest.mock import patch


class NotebookTests(unittest.TestCase):
    def setUp(self):
        self.notebook = json.loads(Path(__file__).with_name("Nexus_Colab_Kaggle.ipynb").read_text(encoding="utf-8"))

    def test_format_and_cell_syntax(self):
        self.assertEqual(self.notebook["nbformat"], 4)
        ids = []
        for cell in self.notebook["cells"]:
            ids.append(cell["id"])
            if cell["cell_type"] == "code":
                ast.parse("".join(cell["source"]))
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
        self.assertEqual(len(set(ids)), len(ids))

    def test_desktop_is_rejected_before_subprocess(self):
        guard = next(cell for cell in self.notebook["cells"] if cell["id"] == "cloud-guard")
        with patch.dict("os.environ", {}, clear=True), patch("subprocess.run") as run:
            with self.assertRaisesRegex(RuntimeError, "zdalny runtime"):
                exec(compile("".join(guard["source"]), "<notebook-cloud-guard>", "exec"), {})
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
