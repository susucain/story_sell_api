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

  it('scopes the screenwriter away from video generation tools', () => {
    const profile = registry.getRoleProfile('screenwriter');

    expect(profile.allowedTools).not.toContain('create_video_task');
    expect(profile.allowedTools).toContain('generate_script');
  });

  it('only lets the director trigger video generation', () => {
    const withGeneration = registry
      .listRoleProfiles()
      .filter((profile) => profile.allowedTools.includes('create_video_task'))
      .map((profile) => profile.id);

    expect(withGeneration).toEqual(['director']);
  });

  it('rejects an unknown role id', () => {
    expect(() => registry.getRoleProfile('actor' as never)).toThrow(
      '未知 agent role',
    );
  });
});