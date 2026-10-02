/**
 * Nexus Portrait Generator
 * 
 * Generates or refines realistic portrait images of Nexus.
 * Supports:
 * - Stable Diffusion / Flux (local via Ollama/ComfyUI)
 * - DALL-E 3 (cloud)
 * - Custom art style pipeline
 * 
 * Specification:
 * - Male humanoid, space-themed aesthetic
 * - Silver-white hair, glowing blue eyes
 * - Dark blue/black cosmic armor with silver accents
 * - Blue-violet energy aura/halo
 * - Orbital rings or tech elements
 * - Photorealistic face (like cinematic character)
 * - 512x512 or higher resolution (FasterLivePortrait optimal size)
 */

import type { AIProvider } from './aiProviderRouter';

export interface NexusPortraitSpec {
  name: string;
  description: string;
  negativePrompt: string;
  style: string;
  resolution: '512x512' | '768x768' | '1024x1024';
  seed?: number;
}

export interface PortraitGenerationRequest {
  model: 'flux' | 'dalle3' | 'stable-diffusion' | 'local-sd';
  spec: NexusPortraitSpec;
  outputPath: string;
  upscale?: boolean;
}

export interface PortraitGenerationResult {
  success: boolean;
  imagePath?: string;
  seed?: number;
  prompt?: string;
  error?: string;
  generatedAt?: Date;
}

const NEXUS_PORTRAIT_SPEC: NexusPortraitSpec = {
  name: 'Nexus',
  description: `
Photorealistic portrait of Nexus, a male humanoid space AI assistant.
Character specifications:
- Age: appear 30-40 years old
- Hair: long, flowing silver-white hair with subtle blue luminescence
- Eyes: large, piercing electric blue with a subtle glowing effect, intelligent and kind
- Skin: pale, smooth, slightly translucent with subtle blue undertones
- Face: angular, symmetrical, futuristic yet human-like features
- Expression: calm, focused, slightly warm smile
- Attire: sleek dark navy/black cosmic armor with silver accents and glowing blue energy lines
- Aura: subtle blue-violet ethereal energy field around the head and shoulders
- Accessories: floating orbital rings or holographic elements around the head
- Setting: dark space background with distant stars and nebulas
- Lighting: cool blue-white ambient lighting, dramatic cinematic quality
- Style: hyper-realistic, 3D rendered, high detail, professional cinematic character design
  `.trim(),
  negativePrompt: `
low quality, blurry, distorted, anime, cartoon, painting style, sketch,
multiple faces, wrong anatomy, deformed, mutated features,
yellow/green colors, warm tones, human-only plain appearance,
mechanical robot without human features, text, watermark
  `.trim(),
  style: 'cinematic, photorealistic, high-detailed, character portrait, professional lighting',
  resolution: '512x512',
};

/**
 * Generate a Flux prompt from the Nexus specification
 */
export function generateFluxPrompt(spec: NexusPortraitSpec = NEXUS_PORTRAIT_SPEC): string {
  return `
${spec.description}

Technical parameters:
- Quality: masterpiece, best quality, highly detailed
- Rendering: photorealistic 3D render, cinematic lighting
- Resolution: ${spec.resolution}
- Style: ${spec.style}
  `.trim();
}

/**
 * Generate a DALL-E 3 prompt (simpler, more narrative)
 */
export function generateDallE3Prompt(spec: NexusPortraitSpec = NEXUS_PORTRAIT_SPEC): string {
  return `
A photorealistic cinematic portrait of Nexus, an ethereal male humanoid space AI:
- Long flowing silver-white hair with blue luminescence
- Large electric blue glowing eyes (intelligent, kind)
- Pale skin with subtle blue undertones, angular symmetrical face
- Sleek dark navy cosmic armor with silver accents and glowing blue energy lines
- Subtle blue-violet aura around head and shoulders
- Floating orbital rings or holographic elements
- Dark space background with distant stars
- Cool blue-white cinematic lighting, professional character design
- Style: hyper-realistic 3D render, high detail, masterpiece quality
  `.trim();
}

/**
 * Try to generate portrait via local Stable Diffusion (ComfyUI/Ollama)
 */
export async function generateLocalPortrait(
  outputPath: string,
  aiProvider?: AIProvider
): Promise<PortraitGenerationResult> {
  try {
    // This would require a running ComfyUI or similar backend
    // For now, return a placeholder instruction
    console.warn('Local portrait generation not yet implemented');
    console.warn('To enable: set up ComfyUI or Ollama with Flux/SD model');
    
    return {
      success: false,
      error: 'Local portrait generation not configured. Please set up ComfyUI or Ollama.',
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Generate portrait via Gemini (text description analysis)
 */
export async function generatePortraitPromptViaGemini(
  aiProvider?: AIProvider
): Promise<string> {
  if (!aiProvider) {
    return generateFluxPrompt();
  }

  try {
    // Use Gemini to refine the portrait prompt
    const systemPrompt = `
You are a world-class concept artist and character designer.
Your task is to create a detailed, evocative prompt for an AI image generator (Flux or DALL-E 3).
The prompt should describe Nexus, a futuristic male AI humanoid avatar.

Focus on:
- Photorealistic, cinematic quality
- Technical accuracy (realistic anatomy, lighting, materials)
- Emotional warmth alongside futuristic design
- Specific color palette (silver, white, electric blue, dark navy)
- Detailed facial features and expression

Output: A single, cohesive prompt suitable for feeding directly to an image generator.
Keep it under 300 words but extremely detailed and descriptive.
    `;

    const result = await aiProvider.generate({
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Create a detailed AI image generation prompt for Nexus based on this specification:\n${NEXUS_PORTRAIT_SPEC.description}\n\nMake it photorealistic and cinematic. Return ONLY the prompt, no explanations.`,
        },
      ],
    });

    return result?.content || generateFluxPrompt();
  } catch (error) {
    console.warn('Gemini prompt generation failed, using default:', error);
    return generateFluxPrompt();
  }
}

/**
 * Quick portrait fetcher — check if realistic portrait already exists
 */
export async function getOrCreatePortrait(
  portraitDir: string,
  aiProvider?: AIProvider
): Promise<string> {
  const { existsSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  const portraitPath = join(portraitDir, 'nexus_realistic_portrait.png');

  if (existsSync(portraitPath)) {
    console.log(`[Portrait] Found existing portrait: ${portraitPath}`);
    return portraitPath;
  }

  // No portrait found — log instructions for user
  console.warn(`[Portrait] No realistic portrait found at ${portraitPath}`);
  console.warn(`[Portrait] To generate one, use:`);
  console.warn(`  1. Flux (local ComfyUI): Portrait will be saved to ${portraitPath}`);
  console.warn(`  2. DALL-E 3 (cloud): Use prompt from generateDallE3Prompt()`);
  console.warn(`  3. Manual: Place your portrait image at ${portraitPath}`);
  console.warn(`[Portrait] Falling back to test portrait for now.`);

  // Return test portrait as fallback
  return join(portraitDir, 'nexus_test_portrait.png');
}

/**
 * Export portrait metadata for UI/animation
 */
export interface PortraitMetadata {
  path: string;
  isRealistic: boolean;
  isTest: boolean;
  resolution: [number, number];
  generatedAt?: Date;
  model?: string;
  seed?: number;
}

export async function getPortraitMetadata(portraitPath: string): Promise<PortraitMetadata> {
  const { statSync, existsSync } = await import('fs');
  const { basename } = await import('path');

  const isTest = basename(portraitPath).includes('test');
  const isRealistic = !isTest && basename(portraitPath).includes('realistic');

  if (!existsSync(portraitPath)) {
    return {
      path: portraitPath,
      isRealistic: false,
      isTest: true,
      resolution: [512, 512],
    };
  }

  const stat = statSync(portraitPath);

  return {
    path: portraitPath,
    isRealistic,
    isTest,
    resolution: [512, 512], // Would need to read actual PNG dimensions
    generatedAt: stat.mtime,
  };
}

/**
 * Instruction generator for users to create portrait manually
 */
export function getPortraitGenerationInstructions(): string {
  return `
╔═══════════════════════════════════════════════════════════════════════════╗
║                   NEXUS PORTRAIT GENERATION GUIDE                          ║
╚═══════════════════════════════════════════════════════════════════════════╝

Option 1: DALL-E 3 (Recommended for Quick Photorealism)
─────────────────────────────────────────────────────────
1. Go to https://openai.com/dall-e-3
2. Use this prompt:

${generateDallE3Prompt()}

3. Download the generated image (square format preferred)
4. Save to: C:\\Users\\damian\\FasterLivePortrait\\checkpoints\\nexus_realistic_portrait.png
5. Restart Nexus

Option 2: Flux (Local, Open Source)
─────────────────────────────────────
1. Set up ComfyUI: https://github.com/comfyanonymous/ComfyUI
2. Install Flux model: https://huggingface.co/black-forest-labs/FLUX.1-dev
3. Run ComfyUI workflow with prompt:

${generateFluxPrompt()}

4. Save output to: C:\\Users\\damian\\FasterLivePortrait\\checkpoints\\nexus_realistic_portrait.png

Option 3: Midjourney
────────────────────
1. Go to https://www.midjourney.com/
2. Use prompt:

${generateFluxPrompt()}

3. Download and save to portrait path

Option 4: Manual Artwork
────────────────────────
1. Commission an artist or create custom portrait
2. Specifications:
   - Format: PNG, 512×512 (or higher, will be scaled)
   - Color palette: silver, white, electric blue, dark navy
   - Style: photorealistic, cinematic, character portrait
   - Include: head and shoulders, facing camera, calm expression
3. Save to: C:\\Users\\damian\\FasterLivePortrait\\checkpoints\\nexus_realistic_portrait.png

Current Test Portrait
──────────────────────
- Location: checkpoints/nexus_test_portrait.png
- Status: PLACEHOLDER (blue placeholder head)
- Action: Replace with any of the above options when ready
  `;
}
