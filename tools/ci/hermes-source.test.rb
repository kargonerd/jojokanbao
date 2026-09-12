require 'tmpdir'
require 'fileutils'

require_relative '../../node_modules/react-native/sdks/hermes-engine/hermes-utils'

# Test the installed dependency patch without contacting Maven or GitHub.
def release_artifact_exists(_version)
  $release_available
end

def nightly_artifact_exists(_version)
  false
end

def assert_equal(expected, actual)
  raise "Expected #{expected.inspect}, got #{actual.inspect}" unless expected == actual
end

%w[REACT_NATIVE_OVERRIDE_HERMES_DIR HERMES_ENGINE_TARBALL_PATH HERMES_COMMIT RCT_BUILD_HERMES_FROM_SOURCE RCT_HERMES_V1_ENABLED].each { |key| ENV.delete(key) }

Dir.mktmpdir('hermes-source-test') do |root|
  FileUtils.mkdir_p(File.join(root, 'sdks'))
  File.write(File.join(root, 'sdks', '.hermesversion'), "hermes-v0.14.1\n")
  File.write(File.join(root, 'sdks', '.hermesv1version'), "hermes-v1-test\n")

  $release_available = true
  assert_equal(HermesEngineSourceType::DOWNLOAD_PREBUILD_RELEASE_TARBALL, hermes_source_type('0.14.1', root))

  $release_available = false
  source_type = hermes_source_type('0.14.1', root)
  assert_equal(HermesEngineSourceType::BUILD_FROM_GITHUB_TAG, source_type)
  assert_equal({ git: HERMES_GITHUB_URL, tag: 'hermes-v0.14.1' }, podspec_source(source_type, '0.14.1', root))

  ENV['RCT_HERMES_V1_ENABLED'] = '1'
  assert_equal({ git: HERMES_GITHUB_URL, tag: 'hermes-v1-test' }, podspec_source(hermes_source_type('v1', root), 'v1', root))
  ENV.delete('RCT_HERMES_V1_ENABLED')

  ENV['HERMES_COMMIT'] = 'explicitly-selected-commit'
  assert_equal(HermesEngineSourceType::BUILD_FROM_GITHUB_COMMIT, hermes_source_type('0.14.1', root))
  ENV.delete('HERMES_COMMIT')

  File.delete(File.join(root, 'sdks', '.hermesversion'))
  begin
    hermes_source_type('0.14.1', root)
    raise 'Missing tag must fail instead of selecting the latest development commit'
  rescue RuntimeError => error
    raise unless error.message.include?('no pinned Hermes tag')
  end

  assert_equal(false, hermes_artifact_exists(''))
end

puts 'Hermes source selection contracts passed'
