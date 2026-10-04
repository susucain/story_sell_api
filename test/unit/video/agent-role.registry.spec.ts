import { AgentRoleRegistryService } from '../../../src/video/agent-role.registry';

describe('AgentRoleRegistryService', () => {
  const registry = new AgentRoleRegistryService();

  it('exposes a director profile that can dispatch role agents', () => {
    const profile = registry.getRoleProfile('director');

    expect(profile.allowedSkills).toContain(
      'life-service-storyboard-generator',
    );
    expect(profile.dispatches).toEqual(
      expect.arrayContaining([
        'screenwriter',
        'shot-planner',
        'cinematographer',
      ]),
    );
  });

  it('scopes advisor roles away from persistence and video generation', () => {
    for (const roleId of [
      'screenwriter',
      'shot-planner',
      'cinematographer',
    ] as const) {
      const profile = registry.getRoleProfile(roleId);

      expect(profile.allowedTools).not.toContain('create_video_task');
      expect(profile.allowedTools).not.toContain('start_script_creation');
      expect(profile.allowedTools).not.toContain('generate_script');
      expect(profile.allowedTools).toContain('read_file');
    }
  });

  it('only lets the director persist scripts and trigger video generation', () => {
    const withGeneration = registry
      .listRoleProfiles()
      .filter((profile) => profile.allowedTools.includes('create_video_task'))
      .map((profile) => profile.id);
    const withPersistence = registry
      .listRoleProfiles()
      .filter((profile) => profile.allowedTools.includes('generate_script'))
      .map((profile) => profile.id);

    expect(withGeneration).toEqual(['director']);
    expect(withPersistence).toEqual(['director']);
  });

  it('rejects an unknown role id', () => {
    expect(() => registry.getRoleProfile('actor' as never)).toThrow(
      '未知 agent role',
    );
  });
});
