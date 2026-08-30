import { Button, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'

export default function SettingsScreen() {
  const navigation = useNavigation()
  return (
    <View>
      <Button title="Replay intro" onPress={() => navigation.navigate('Onboarding')} />
    </View>
  )
}
