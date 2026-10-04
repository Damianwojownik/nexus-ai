"""Optional fixed upper-portrait layer for experimental body previews."""
import math

import cv2
import numpy as np
from PIL import Image


def protect_upper_portrait(frame, source, protected_fraction, feather_fraction):
    if not (
        math.isfinite(protected_fraction)
        and math.isfinite(feather_fraction)
        and 0 < protected_fraction < 1
        and 0 < feather_fraction
        and protected_fraction + feather_fraction < 1
    ):
        raise ValueError("Protected and feather fractions must leave a moving body region")
    generated = np.asarray(frame)
    original = np.asarray(source)
    if generated.shape != original.shape or original.ndim != 3 or original.shape[2] != 3:
        raise ValueError("Source and generated frame must have identical RGB dimensions")
    if generated.dtype != np.uint8 or original.dtype != np.uint8:
        raise ValueError("Layer inputs must be uint8 RGB images")
    height = original.shape[0]
    protected_rows = math.ceil(height * protected_fraction)
    feather_rows = math.ceil(height * feather_fraction)
    if protected_rows + feather_rows >= height:
        raise ValueError("Frame is too small for the requested layer boundaries")
    alpha = np.ones((height, 1, 1), dtype=np.float32)
    alpha[:protected_rows] = 0
    ramp = np.linspace(0, 1, feather_rows + 2, dtype=np.float32)[1:-1]
    alpha[protected_rows:protected_rows + feather_rows, 0, 0] = ramp * ramp * (3 - 2 * ramp)
    pixels = np.rint(original * (1 - alpha) + generated * alpha).astype(np.uint8)
    if not np.array_equal(pixels[:protected_rows], original[:protected_rows]):
        raise RuntimeError("Protected portrait pixels changed before video encoding")
    return Image.fromarray(pixels)


def face_references(path, source, count, fps):
    """Align an explicit upper-square portrait clip to a taller body source."""
    width, height = source.size
    if height < width or count <= 0 or not math.isfinite(fps) or fps <= 0:
        raise ValueError("Face layering requires a tall source and valid frame count/rate")
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise RuntimeError("Cannot decode the selected face-engine clip")
        face_fps = capture.get(cv2.CAP_PROP_FPS)
        if not math.isfinite(face_fps) or face_fps <= 0:
            raise RuntimeError("Face-engine clip has no valid frame rate")
        references = []
        decoded_index = -1
        face = None
        for index in range(count):
            target = math.floor(index * face_fps / fps)
            while decoded_index < target:
                ok, pixels = capture.read()
                if not ok:
                    raise RuntimeError("Face-engine clip is shorter than the body preview")
                if pixels.shape[0] != pixels.shape[1]:
                    raise ValueError("Face-engine clip must use the original upper-square crop")
                face = cv2.resize(cv2.cvtColor(pixels, cv2.COLOR_BGR2RGB), (width, width))
                decoded_index += 1
            reference = np.array(source, copy=True)
            reference[:width] = face
            references.append(Image.fromarray(reference))
        return references
    finally:
        capture.release()


def face_timeline(path):
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise RuntimeError("Cannot decode the selected face-engine clip")
        count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        fps = capture.get(cv2.CAP_PROP_FPS)
        if (
            not math.isfinite(count) or count < 2 or count != int(count)
            or not math.isfinite(fps) or fps <= 0
            or count / fps > 30
        ):
            raise ValueError("Face timeline must contain 2 or more frames and last at most 30 seconds")
        return int(count), fps
    finally:
        capture.release()


def motion_frame_indices(source_count, target_count):
    if source_count < 2 or target_count < 2:
        raise ValueError("Motion retiming requires at least two source and target frames")
    return np.rint(np.linspace(0, source_count - 1, target_count)).astype(int).tolist()


def validate_face_box(box):
    if (
        not isinstance(box, list) or len(box) != 4
        or any(type(value) not in (int, float) or not math.isfinite(value) for value in box)
    ):
        raise ValueError("faceBox must contain four finite normalized numbers: x, y, width, height")
    x, y, width, height = box
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
        raise ValueError("faceBox must lie inside the output frame")
    return box


class HeadTracker:
    """Track source-anchored features with checked forward/backward optical flow."""

    def __init__(self, source, box):
        pixels = np.asarray(source)
        height, width = pixels.shape[:2]
        x, y, w, h = validate_face_box(box)
        self.box = np.array([x * width, y * height, w * width, h * height])
        x0, y0, bw, bh = self.box
        mask = np.zeros((height, width), dtype=np.uint8)
        # Exclude the mouth and box edges so lip motion does not drive head alignment.
        mask[
            math.ceil(y0 + .08 * bh):math.floor(y0 + .65 * bh),
            math.ceil(x0 + .12 * bw):math.floor(x0 + .88 * bw),
        ] = 255
        self.previous = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
        self.points = cv2.goodFeaturesToTrack(
            self.previous, maxCorners=160, qualityLevel=.01, minDistance=4, mask=mask,
        )
        if self.points is None or len(self.points) < 12:
            raise RuntimeError("Head tracking requires at least 12 textured features inside faceBox")
        self.anchors = self.points.copy()
        self.shape = pixels.shape
        self.feature_mask = mask

    def advance(self, frame):
        pixels = np.asarray(frame)
        if pixels.shape != self.shape or pixels.dtype != np.uint8:
            raise ValueError("Tracked frames must have identical uint8 RGB dimensions")
        current = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
        moved, status, _ = cv2.calcOpticalFlowPyrLK(
            self.previous, current, self.points, None, winSize=(21, 21), maxLevel=3,
        )
        if moved is None or status is None:
            raise RuntimeError("Head tracking failed: no forward optical flow")
        returned, back_status, _ = cv2.calcOpticalFlowPyrLK(
            current, self.previous, moved, None, winSize=(21, 21), maxLevel=3,
        )
        if returned is None or back_status is None:
            raise RuntimeError("Head tracking failed: no backward optical flow")
        good = (
            status.ravel().astype(bool) & back_status.ravel().astype(bool)
            & np.isfinite(moved).all(axis=(1, 2))
            & (np.linalg.norm(returned - self.points, axis=2).ravel() < 1.5)
        )
        anchors = self.anchors[good]
        targets = moved[good]
        if len(targets) < 12:
            raise RuntimeError("Head tracking lost reliable features; reject this motion clip")
        matrix, inliers = cv2.estimateAffinePartial2D(
            anchors, targets, method=cv2.RANSAC, ransacReprojThreshold=2.0,
        )
        if matrix is None or inliers is None or not np.isfinite(matrix).all():
            raise RuntimeError("Head alignment failed to estimate a finite similarity transform")
        keep = inliers.ravel().astype(bool)
        if keep.sum() < 12 or keep.mean() < .65:
            raise RuntimeError("Head alignment has too few agreeing features")
        predicted = cv2.transform(anchors, matrix)
        if np.median(np.linalg.norm(predicted[keep] - targets[keep], axis=2)) > 1.5:
            raise RuntimeError("Head alignment exceeds the reprojection error threshold")
        scale = math.hypot(matrix[0, 0], matrix[1, 0])
        angle = abs(math.degrees(math.atan2(matrix[1, 0], matrix[0, 0])))
        if not .75 <= scale <= 1.3 or angle > 25:
            raise RuntimeError("Head motion exceeds supported scale/rotation; reject this clip")
        x, y, w, h = self.box
        corners = np.array([[[x, y], [x + w, y], [x, y + h], [x + w, y + h]]], dtype=np.float32)
        transformed = cv2.transform(corners, matrix)[0]
        height, width = current.shape
        if (
            (transformed[:, 0] < 0).any() or (transformed[:, 0] >= width).any()
            or (transformed[:, 1] < 0).any() or (transformed[:, 1] >= height).any()
        ):
            raise RuntimeError("Tracked head leaves the frame")
        self.points = targets[keep]
        self.anchors = anchors[keep]
        self.previous = current
        if len(self.points) < 100:
            region = cv2.warpAffine(self.feature_mask, matrix, (width, height))
            for point in self.points[:, 0]:
                cv2.circle(region, tuple(np.rint(point).astype(int)), 5, 0, -1)
            added = cv2.goodFeaturesToTrack(
                current, maxCorners=160 - len(self.points),
                qualityLevel=.01, minDistance=4, mask=region,
            )
            if added is not None:
                # Anchor new observations through the verified current transform.
                anchored = cv2.transform(added, cv2.invertAffineTransform(matrix))
                self.points = np.concatenate([self.points, added])
                self.anchors = np.concatenate([self.anchors, anchored])
        return matrix


def tracked_face_composite(frames, references, source, box, feather):
    validate_face_box(box)
    if type(feather) not in (int, float) or not math.isfinite(feather) or not 0 < feather < .5:
        raise ValueError("Tracked feather must be a finite fraction of the face radius in (0, 0.5)")
    if len(frames) != len(references) or not frames:
        raise ValueError("Tracked face and body timelines must have the same nonzero frame count")
    body_tracker = HeadTracker(source, box)
    face_tracker = HeadTracker(source, box)
    height, width = np.asarray(source).shape[:2]
    x, y, w, h = box
    yy, xx = np.mgrid[:height, :width]
    radius = np.sqrt(
        ((xx - (x + w / 2) * width) / (w * width / 2)) ** 2
        + ((yy - (y + h / 2) * height) / (h * height / 2)) ** 2
    )
    edge = np.clip((1 - radius) / feather, 0, 1)
    source_mask = (edge * edge * (3 - 2 * edge)).astype(np.float32)
    result = []
    for index, (body, face) in enumerate(zip(frames, references)):
        try:
            body_matrix = body_tracker.advance(body)
            face_matrix = face_tracker.advance(face)
        except (ValueError, RuntimeError) as error:
            raise RuntimeError(f"Tracked face composition failed at frame {index}: {error}") from error
        body_homogeneous = np.vstack([body_matrix, [0, 0, 1]])
        face_homogeneous = np.vstack([face_matrix, [0, 0, 1]])
        mapping = (body_homogeneous @ np.linalg.inv(face_homogeneous))[:2]
        aligned = cv2.warpAffine(
            np.asarray(face), mapping, (width, height), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
        )
        mask = cv2.warpAffine(source_mask, body_matrix, (width, height))[:, :, None]
        support = cv2.warpAffine(np.ones((height, width), np.float32), mapping, (width, height))
        if np.any((mask[:, :, 0] > .01) & (support < .99)):
            raise RuntimeError(f"Face layer lacks pixels for the tracked mask at frame {index}")
        pixels = np.rint(aligned * mask + np.asarray(body) * (1 - mask)).astype(np.uint8)
        result.append(Image.fromarray(pixels))
    return result
