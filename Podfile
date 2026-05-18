# Uncomment the next line to define a global platform for your project
platform :ios, '15.0'

target 'StudyTrace' do
  # Comment the next line if you're not using Swift and don't want to use dynamic frameworks
  use_frameworks!

  # Pods for StudyTrace
  pod 'AWAREFramework', '~> 1.14.5'
  # pod 'AWAREFramework/Microphone' , '~> 1.14.5'  # Disabled: StudentLifeAudio lacks arm64-simulator slice
  pod 'AWAREFramework/MotionActivity', '~> 1.14.5'
  pod 'AWAREFramework/Bluetooth', '~> 1.14.5'
  pod 'AWAREFramework/Calendar', '~> 1.14.5'
  pod 'AWAREFramework/Contact', '~> 1.14.5'
  pod 'AWAREFramework/HealthKit', '~> 1.14.5'
  
#  pod 'AWAREFramework'               , :path => '../AWAREFramework-iOS'
#  pod 'AWAREFramework/Microphone'    , :path => '../AWAREFramework-iOS'
#  pod 'AWAREFramework/MotionActivity', :path => '../AWAREFramework-iOS'
#  pod 'AWAREFramework/Bluetooth'     , :path => '../AWAREFramework-iOS'
#  pod 'AWAREFramework/Calendar'      , :path => '../AWAREFramework-iOS'
#  pod 'AWAREFramework/Contact'       , :path => '../AWAREFramework-iOS'
#  pod 'AWAREFramework/HealthKit'     , :path => '../AWAREFramework-iOS'

  pod 'DGCharts', '~> 5.1.0'
  pod 'DynamicColor', '~> 5.0.1'
  
  target 'StudyTraceTests' do
    inherit! :search_paths
    # Pods for testing
  end

  target 'StudyTraceUITests' do
    inherit! :search_paths
    # Pods for testing
  end

end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
      config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'i386'
      config.build_settings['BUILD_LIBRARY_FOR_DISTRIBUTION'] = 'YES'
    end
  end

  # Fix embed script: remove StudentLifeAudio and relax unbound variable check
  Dir.glob(File.join(__dir__, 'Pods', 'Target Support Files', '**', '*-frameworks.sh')).each do |script|
    content = File.read(script)
    content.gsub!('set -u', 'set +u')
    content.gsub!(/.*StudentLifeAudio.*\n/, '')
    File.write(script, content)
  end
end
