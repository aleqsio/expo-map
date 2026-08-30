import { Button, Modal, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'

export default function OnboardingScreen() {
  const navigation = useNavigation()
  return (
    <View>
      <Modal visible={false} />
      <Button title="Done" onPress={() => navigation.navigate('Tabs', { screen: 'Feed' })} />
    </View>
  )
}
