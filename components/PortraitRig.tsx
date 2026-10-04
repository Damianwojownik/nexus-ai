import { useEffect, useRef, type RefObject } from 'react';
import { PortraitRigRenderer, type PortraitFrame } from '../helpers/portraitRig';

type Props = {
  source: string;
  className?: string;
  frameRef: RefObject<PortraitFrame>;
  onError: (error: Error) => void;
};

export function PortraitRig({ source, className, frameRef, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    const renderer = new PortraitRigRenderer({
      columns: 1, rows: 1, crop: { x: 0, y: 0, width: 1, height: 1 },
      head: { x: .5, y: .4, rx: .32, ry: .36 },
      basePose: () => 0, layers: () => [],
    });
    let disposed = false;
    let raf = 0;
    const update = () => {
      renderer.setFrame(frameRef.current);
      raf = requestAnimationFrame(update);
    };
    void renderer.load(source).then(() => {
      if (disposed || !canvasRef.current) return;
      renderer.attach(canvasRef.current);
      renderer.setFrame(frameRef.current);
      renderer.start();
      update();
    }).catch((error: unknown) => {
      if (disposed) return;
      console.error('Nexus portrait renderer failed', error);
      errorRef.current(error instanceof Error ? error : new Error(String(error)));
    });
    return () => { disposed = true; cancelAnimationFrame(raf); renderer.dispose(); };
  }, [source, frameRef]);
  return <canvas ref={canvasRef} className={className} role="img" aria-label="Nexus — własny portret z ruchem głowy i ramion; bez generowania wideo" />;
}
