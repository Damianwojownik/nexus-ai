import { mkdir, realpath, writeFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { safeProjectName, validateGeneratedProject } from './projectBuilder.ts';
import type { GeneratedProject } from './projectBuilder.ts';

export interface CreatedWorkspaceProject {
  name: string;
  summary: string;
  path: string;
  files: string[];
}

export async function createWorkspaceProject(
  workspaceDir: string,
  projectValue: unknown,
  confirmed: boolean,
): Promise<CreatedWorkspaceProject> {
  if (!confirmed) throw new Error('Explicit confirmation is required to create a new project');
  const project = validateGeneratedProject(projectValue as GeneratedProject);
  const projectName = safeProjectName(project.name);

  await mkdir(workspaceDir, { recursive: true });
  const root = await realpath(workspaceDir);
  const projectDir = resolve(root, projectName);
  const relativeProject = relative(root, projectDir);
  if (!relativeProject || relativeProject.startsWith('..') || isAbsolute(relativeProject)) throw new Error('Invalid project path');

  try {
    await lstat(projectDir);
    throw new Error(`Project already exists: ${projectName}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(projectDir, { recursive: false });
  const written: string[] = [];
  for (const file of project.files) {
    const target = resolve(projectDir, file.path);
    const rel = relative(projectDir, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe generated path: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: 'wx' });
    written.push(rel.split(sep).join('/'));
  }

  return { name: projectName, summary: project.summary, path: relativeProject.split(sep).join('/'), files: written };
}
