"""Import a known collage layout; never infer unseen body geometry."""
import argparse
import json
from pathlib import Path
import shutil

ROLES = (
    "neutral", "eyes_closed", "wink", "smile", "frown", "reach_front",
    "profile_left", "three_quarter", "back_three_quarter", "reach_close",
    "reach_side", "smile_eyes_closed",
)
COSMIC_EXPRESSIONS = (
    "calm", "gentle_smile", "joy", "wonder", "curiosity", "focus",
    "confidence", "surprise", "intrigue", "thinking", "empathy", "care",
    "pride", "playfulness", "wink", "amusement", "laughter", "shyness",
    "sadness", "longing", "concern", "astonishment", "determination", "serious",
    "analysis", "inspiration", "relief", "gratitude", "farewell", "rest",
)
COSMIC_STORYBOARD = (
    "intro_logo", "wake", "eye_contact", "smile", "hand_greeting", "welcome",
    "conversation", "question", "help", "chat", "presence", "capabilities",
    "nearby", "everywhere", "knowledge", "information", "ai", "analysis",
    "solutions", "projects", "technology", "possibilities", "invitation", "together",
    "thanks", "goodbye", "companion", "horizons", "outro_logo", "fade",
)


def crop_boxes(width, height, columns=6, rows=2, bottom=0):
    if type(columns) is not int or type(rows) is not int or not 1 <= columns <= 12 or not 1 <= rows <= 12:
        raise ValueError("Collage grid must have 1..12 columns and rows")
    if type(bottom) is not int or not 0 <= bottom <= 64:
        raise ValueError("Caption inset must be an integer in 0..64 pixels")
    if width // columns < 64 or height // rows < 128:
        raise ValueError("Collage cells must be at least 64x128 pixels")
    if height // rows - bottom < 96:
        raise ValueError("Caption crop must leave at least 96 pixels of panel height")
    return [(column * width // columns, row * height // rows,
             (column + 1) * width // columns, (row + 1) * height // rows - bottom)
            for row in range(rows) for column in range(columns)]


def import_collage(source, destination, columns=6, rows=2, bottom=0, layout="grid"):
    from PIL import Image
    source, destination = Path(source), Path(destination)
    if destination.exists():
        raise FileExistsError("Choose a new character-pack directory; existing packs are preserved")
    with Image.open(source) as original:
        image = original.convert("RGB")
    layouts = {"grid", "cosmic-expressions", "cosmic-storyboard"}
    if layout not in layouts:
        raise ValueError("Unknown reference layout")
    if layout != "grid":
        columns, rows = 6, 5
    boxes = crop_boxes(*image.size, columns, rows, bottom)
    destination.mkdir(parents=True)
    references = []
    for index, box in enumerate(boxes):
        if layout == "cosmic-expressions":
            role = COSMIC_EXPRESSIONS[index]
        elif layout == "cosmic-storyboard":
            role = COSMIC_STORYBOARD[index]
        else:
            role = ROLES[index] if (columns, rows) == (6, 2) else f"reference_{index + 1:02}"
        filename = f"{index + 1:02}-{role}.png"
        image.crop(box).save(destination / filename)
        reference_type = "scene" if layout == "cosmic-storyboard" and index in (0, 27, 28, 29) else "portrait"
        references.append({"role": role, "file": filename, "sourceBox": list(box), "type": reference_type})
    manifest = {"version": 1, "kind": "image-references", "sourceSize": list(image.size),
                "grid": [columns, rows], "captionInsetBottom": bottom, "layout": layout,
                "references": references, "labelsArePositional": True,
                "defaultRole": "eye_contact" if layout == "cosmic-storyboard" else references[0]["role"],
                "reconstructs3D": False}
    (destination / "character.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def select_reference(pack, role, job):
    from PIL import Image
    pack, job = Path(pack).resolve(), Path(job)
    manifest = json.loads((pack / "character.json").read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("kind") != "image-references":
        raise ValueError("Unsupported character pack")
    references = [item for item in manifest["references"] if item["role"] == role]
    if len(references) != 1:
        raise ValueError("Choose exactly one existing reference role")
    if references[0].get("type", "portrait") != "portrait":
        raise ValueError("A scene/logo reference is not a face source")
    source = (pack / references[0]["file"]).resolve()
    if source.parent != pack or not source.is_file():
        raise ValueError("Reference must be an image inside the character pack")
    with Image.open(source) as image:
        image.verify()
    if not job.is_dir() or list(job.glob("portrait.*")):
        raise ValueError("Choose an existing empty portrait job")
    shutil.copy2(source, job / "portrait.png")
    (job / "reference-settings.json").write_text(json.dumps({
        "role": role, "sourceFile": source.name, "reconstructs3D": False,
    }, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import")
    importer.add_argument("source")
    importer.add_argument("destination")
    importer.add_argument("--columns", type=int, default=6)
    importer.add_argument("--rows", type=int, default=2)
    importer.add_argument("--bottom", type=int, default=0)
    importer.add_argument("--layout", choices=("grid", "cosmic-expressions", "cosmic-storyboard"), default="grid")
    selector = commands.add_parser("select")
    selector.add_argument("pack")
    selector.add_argument("role")
    selector.add_argument("job")
    args = parser.parse_args()
    if args.command == "import":
        manifest = import_collage(args.source, args.destination, args.columns, args.rows, args.bottom, args.layout)
        print("CHARACTER_PACK_READY", args.destination, len(manifest["references"]))
    else:
        select_reference(args.pack, args.role, args.job)
        print("REFERENCE_SELECTED", args.role)


if __name__ == "__main__":
    main()
